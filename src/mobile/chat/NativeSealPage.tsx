import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Hash, Utils } from '@bsv/sdk';
import { sdk as toolboxSdk } from '@bsv/wallet-toolbox-client';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from './api';
import { walletSigner } from './signer';
import { nativeAuth } from '../siteGateNative';
import { askWalletPassword } from '../siteGatePassword';
import { approveSealPayment, approveSealWithSheet } from './sealApproval';
import { useSheetPrice } from '../../components/DollarAmount';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { SealPaySheet } from './SealPaySheet';
import {
  DRAW_HINT,
  SLOW_COMMIT_MS,
  createPressGuard,
  estimateSealFee,
  openingNotice,
  primaryHandleFrom,
  retryAllowed,
  sealButtonLabel,
  sealProgress,
  sealReason,
  sealReceipt,
  type SealProgress,
  type SealSheetInfo,
} from './sealScreen';
import {
  NativeSealError,
  abandonSeal,
  inertHtml,
  fetchSignedCopy,
  accountHandles,
  myFields,
  nativeRoomSteps,
  nativeSignAndSeal,
  recoverNativeSeals,
  sealKey,
  sealStateHere,
  signedFieldIds,
  type PendingSeal,
  type PendingSealStore,
  type SealLedger,
  type SealTxLookup,
  type ListActionsFn,
  findSealAction,
  type NativeSealOutcome,
  type SealApi,
  type SealKeys,
  type SealStep,
  type SigField,
} from './nativeSeal';
import { openPendingForLink, type RoomReq } from './nativeSealSource';
import { docHashFor } from './signLink';
import { SignaturePad } from '../signature/SignaturePad';
import type { SigStroke } from '../signature/signature';
import { checkStrictSvg, shortHash, signatureSvg } from '../pair/bitsign';

/**
 * Review, sign and seal a room document NATIVELY (chat/nativeSeal.ts has the why and the protocol). Route:
 * /m/seal/:ticker/:doc. The document is shown inert (no scripts, sandboxed frame), the person draws in the wallet's
 * own pad and presses ONE button, "Sign & seal · ~N sats" (owner, 3 Nov 2026: "Finishing the signature IS sealing
 * it"). That press shows the wallet's payment approval sheet EVERY time (SealPaySheet), then Face ID / passcode or the
 * wallet password (sealApproval.ts); approving it composes, signs and broadcasts at once, with the progress inline
 * under the button (sealScreen.ts) and a receipt at the end.
 *
 * Nothing may interrupt drawing (owner's iPhone, 3 Nov 2026: the copy/select menu, the long-press callout and the
 * magnifier ruined the signature): the whole page is unselectable with no callout (.bw-seal-noselect, mobile.css),
 * the canvas has touch-action: none and swallows touchstart/touchmove (passive: false), contextmenu and selectstart.
 * The document itself scrolls inside its own frame, untouched.
 */

/** Stop iOS selection, the callout and the magnifier on this element and everything in it. */
const NO_SELECT = {
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
} as const;

const STORE_KEY = 'bwx.nativeSeal.pending';
/** Seals recorded from this device by sealKey (identity · document · blocks; nativeSeal.SealLedger). At most 500. */
const SEALED_KEY = 'bwx.nativeSeal.sealed';
const localLedger = (): SealLedger => {
  const read = (): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(SEALED_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: (id) => read().includes(id),
    add: (id) => {
      try {
        localStorage.setItem(SEALED_KEY, JSON.stringify([...read().filter((x) => x !== id), id].slice(-500)));
      } catch {
        /* storage blocked: the in-flight and server checks remain */
      }
    },
  };
};

/**
 * A backup heal or device sync holds the storage locks right now (background STORAGE_MOVE_STATUS backup.storageBusy):
 * the coin check would only queue behind it, so the seal pays without waiting for it (chat/coinWait.ts).
 */
const storageBusy = async (): Promise<boolean> => {
  const r = (await sendMessageAsync({ action: 'STORAGE_MOVE_STATUS' }).catch(() => null)) as {
    success?: boolean;
    data?: { backup?: { storageBusy?: boolean } };
  } | null;
  return r?.success === true && r.data?.backup?.storageBusy === true;
};
const localStore = (): PendingSealStore => {
  const read = (): PendingSeal[] => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (l: PendingSeal[]) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(l));
    } catch {
      /* storage blocked */
    }
  };
  return {
    list: read,
    save: (p) => write([...read().filter((x) => x.nonce !== p.nonce), p]),
    remove: (n) => write(read().filter((x) => x.nonce !== n)),
  };
};

type Doc = {
  documentId: string;
  html: string;
  fields: SigField[];
  title: string;
  manifest: Record<string, unknown> | null;
};
type Phase =
  | { k: 'loading' }
  | { k: 'error'; text: string }
  | { k: 'ready'; note?: string }
  | { k: 'working'; step: SealStep; slow: boolean }
  /** Failed in a way that may have paid: no button (the saved seal is finished by recovery on reopen). */
  | { k: 'failed'; text: string }
  /** What this device already knows about this seal (sealScreen.openingNotice): sealed, or paid and being recorded. */
  | { k: 'notice'; text: string; busy: boolean }
  /** Another party sealed since this version was opened (signer_race): open the latest version. Nothing was paid. */
  | { k: 'stale'; text: string }
  | { k: 'done'; out: NativeSealOutcome; roomError: string | null; feeSats: number | null };

export const NativeSealPage = () => {
  const { ticker = '', doc: docId = '' } = useParams();
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  /**
   * PAD FIRST (owner, 7 Nov 2026): the card-back pad opens as soon as the document is open and checked; Review shows
   * the document and comes back to the pad with the drawing kept (in the 1000 × 250 box).
   */
  const [view, setView] = useState<'pad' | 'review'>('pad');
  const kept = useRef<SigStroke[] | undefined>(undefined);
  /** Double press guard: set synchronously on the first press, cleared only when the button may come back. */
  const press = useRef(createPressGuard()).current;
  /** The payment step has started: from here a failure may have paid (no retry button). */
  const reachedPay = useRef(false);
  const [sheet, setSheet] = useState<{ info: SealSheetInfo; busy: boolean; answer: (ok: boolean) => void } | null>(
    null,
  );
  const price = useSheetPrice();
  const [signedHtml, setSignedHtml] = useState<string | null>(null);
  /** Bumped by "Open the latest version": the document is read again from the room. */
  const [reload, setReload] = useState(0);
  /** This account's identity key: part of the seal's key, so another account on this phone signs on its own. */
  const myKey = chromeStorageService.getCurrentAccountObject().account?.pubKeys?.identityPubKey ?? '';
  /** Recovery of this document's saved payments, started on open (the opening notice waits for it). */
  const recovery = useRef<Promise<number> | null>(null);
  /** The key a press is holding; released on unmount when its payment has not started (nativeSeal.abandonSeal). */
  const holdKey = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (holdKey.current) abandonSeal(holdKey.current);
    },
    [],
  );

  /** The wallet's silent bChatX session (Bearer); signs in with the wallet key when there is none. */
  const client = async (): Promise<BchatClient> => {
    let s = loadSession();
    if (!s) {
      s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(apiContext));
      saveSession(s);
    }
    return new BchatClient(defaultHttp(isNative), s);
  };

  /**
   * An unsure seal's transaction in this wallet's own storage (nativeSeal.SealTxLookup / findSealAction): every
   * action since the record was saved, failed ones too, by the seal's output script; its AtomicBEEF from the wallet's
   * chain services. Any failure → null (held, never dropped).
   */
  const txLookup = (): SealTxLookup => ({
    find: (script, sinceMs) =>
      findSealAction(
        (args) => apiContext.wallet.listActions(args) as ReturnType<ListActionsFn>,
        script,
        sinceMs,
        toolboxSdk.specOpFailedActions,
      ),
    beef: async (txid) => {
      try {
        const services = apiContext.services as unknown as {
          getBeefForTxid?: (t: string) => Promise<{ toBinaryAtomic(t: string): number[] }>;
        };
        return services?.getBeefForTxid ? (await services.getBeefForTxid(txid)).toBinaryAtomic(txid) : null;
      } catch {
        return null;
      }
    },
  });

  const api: SealApi = async (path, body) => {
    const c = await client();
    try {
      const data = (await c.request('POST', `/api/bitsign/nds/seal/${path}`, body)) as Record<string, unknown>;
      return { ok: true, status: 200, body: data ?? {} };
    } catch (e) {
      if (e instanceof ChatApiError)
        return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
      throw e;
    }
  };

  useEffect(() => {
    let live = true;
    if (reload) {
      setDoc(null);
      setSignedHtml(null);
      setPhase({ k: 'loading' });
      press.release();
    }
    void (async () => {
      try {
        const c = await client();
        // The room's pending contract, or the contract built from the upload a QR names (chat/nativeSealSource.ts):
        // the owner signs only on his phone, so scanning the card is the whole flow (CEO, 3 Nov 2026).
        const req: RoomReq = async (method, path, body) => {
          try {
            return {
              ok: true,
              status: 200,
              body: ((await c.request(method, path, body)) as Record<string, unknown>) ?? {},
            };
          } catch (e) {
            if (e instanceof ChatApiError)
              return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
            throw e;
          }
        };
        const out = await openPendingForLink(req, ticker, docId, docHashFor(ticker, docId));
        if (!live) return;
        if (!out.ok) {
          setPhase({ k: 'error', text: out.text });
          return;
        }
        const p = out.pending;
        setDoc({
          documentId: p.documentId,
          html: p.html,
          fields: (p.manifest?.signatureFields as SigField[] | undefined) ?? [],
          title: p.manifest?.documentTitle || 'Document',
          manifest: p.manifest ?? null,
        });
        setPhase({ k: 'ready' });
        recovery.current = recoverNativeSeals(api, localStore(), p.documentId, localLedger(), txLookup());
      } catch (e) {
        if (live) setPhase({ k: 'error', text: e instanceof Error ? e.message : 'Could not open the document.' });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, docId, reload]);

  const me = loadSession()?.handle ?? '';
  /**
   * The account's main name for "from $<name>'s wallet" (sheet and receipt): bit-sign's primary for the session
   * handle ($b0asex → $boase, GET /api/public/handles/primary), else the session handle.
   */
  const [shownHandle, setShownHandle] = useState(() => primaryHandleFrom(null, me));
  useEffect(() => {
    if (!me) return;
    let live = true;
    void (async () => {
      try {
        const c = await client();
        const r = await c.request('GET', `/api/public/handles/primary?h=${encodeURIComponent(me.replace(/^\$/, ''))}`);
        if (live) setShownHandle(primaryHandleFrom(r, me));
      } catch {
        /* the session handle stands */
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  // Every handle on this account counts (accountHandles): a block bound to $boase is yours when you sign in as $b0asex.
  const [handles, setHandles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const c = await client();
        const r = await c.request('GET', '/api/bitsign/me/handles');
        if (live) setHandles(accountHandles(r));
      } catch {
        /* the session handle alone still works */
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const mine = useMemo(
    () => (doc ? myFields(doc.fields, [me, ...handles], signedFieldIds(doc.html)) : []),
    [doc, me, handles],
  );
  /**
   * What this device already knows about THIS seal (this account, this document, these blocks), once the blocks are
   * known: recorded → "Already sealed"; paid and saved → "Paid, being recorded…" until recovery ends, then the real
   * result. Only a hint: the server's already_sealed is the authority, so 'none' shows the pad.
   */
  const opened = useRef('');
  useEffect(() => {
    if (!doc || !mine.length) return;
    const ids = mine.map((f) => f.id);
    const key = sealKey(myKey, doc.documentId, ids);
    if (opened.current === key) return;
    opened.current = key;
    let live = true;
    const show = (recovered: boolean) => {
      const n = openingNotice(sealStateHere(myKey, doc.documentId, ids, localStore(), localLedger()), recovered);
      setPhase((p) =>
        p.k !== 'ready' && p.k !== 'notice' ? p : n ? { k: 'notice', text: n.text, busy: n.busy } : { k: 'ready' },
      );
      return n;
    };
    if (show(false)?.busy)
      void (recovery.current ?? Promise.resolve(0))
        .catch(() => 0)
        .then(() => {
          if (live) show(true);
        });
    return () => {
      live = false;
    };
  }, [doc, mine, myKey]);
  const fingerprint = useMemo(
    () => (doc ? Utils.toHex(Hash.sha256(Utils.toArray(doc.html, 'utf8'))).slice(0, 8) : ''),
    [doc],
  );

  /**
   * Heal BEFORE the tap: once the pad shows, the wallet's coin check (Settings › Troubleshooting › Resync coins:
   * clears coins the chain proves were spent on another device) runs in the background, so the press pays straight
   * away instead of hitting UTXO_SPENT and the in-flight heal + retry (over two minutes on 3 Nov 2026). Silent unless
   * it is still running when he approves ("Finding a fresh coin…").
   */
  const coinCheck = useRef<{ done: boolean; promise: Promise<void> } | null>(null);
  const padShown = phase.k === 'ready' && mine.length > 0;
  useEffect(() => {
    if (!padShown || coinCheck.current) return;
    const c = { done: false, promise: Promise.resolve() };
    c.promise = Promise.resolve()
      .then(() => sendMessageAsync({ action: 'STORAGE_RESYNC_COINS' }))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        c.done = true;
      });
    coinCheck.current = c;
  }, [padShown]);
  /**
   * Read at the press. The wait is on the wall clock with an ~8 s cap and none at all while a heal or sync holds the
   * storage (chat/coinWait.ts): a setTimeout here froze with the app in the background (owner's iPhone, 6 Nov 2026).
   */
  const coins = () => ({
    pending: () => !!coinCheck.current && !coinCheck.current.done,
    done: coinCheck.current?.promise ?? Promise.resolve(),
    storageBusy,
  });

  const ref = String((doc?.manifest?.documentRef as string | undefined) || doc?.documentId || '');
  /** The wallet's own fee rate (sat/kB), the one its createAction pays: the button, sheet and prompt use it. */
  const satsPerKb = () => chromeStorageService.getCustomFeeRate();
  const estFee = useMemo(
    () =>
      mine.length
        ? estimateSealFee(
            mine.map((f) => f.id),
            ref,
            satsPerKb(),
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine, ref],
  );
  /** The fee the sheet / Face ID named, for the receipt when the transaction can't be read. */
  const [namedFee, setNamedFee] = useState<number | null>(null);

  // A slow commit says so ("Waiting for the network…"), never a frozen line.
  const workingStep = phase.k === 'working' ? phase.step : null;
  useEffect(() => {
    if (workingStep !== 'committing') return;
    const t = setTimeout(
      () => setPhase((p) => (p.k === 'working' && p.step === 'committing' ? { ...p, slow: true } : p)),
      SLOW_COMMIT_MS,
    );
    return () => clearTimeout(t);
  }, [workingStep]);

  /** Shows the payment sheet; resolves true on Approve (the sheet stays up, busy, through Face ID), false on Cancel. */
  const showSheet = (info: SealSheetInfo) =>
    new Promise<boolean>((resolve) =>
      setSheet({
        info,
        busy: false,
        answer: (ok) => {
          if (ok) setSheet((cur) => (cur ? { ...cur, busy: true } : cur));
          else setSheet(null);
          resolve(ok);
        },
      }),
    );

  /** The one button. Disabled after the first press; it only comes back after a failure that paid nothing. */
  const signAndSeal = async (svgPath: string) => {
    if (press.held() || !doc || !mine.length) return;
    // The pad's path → the same strict 1000 × 250 SVG the bitsign bridge sends (pair/bitsign.ts), checked before use.
    const svg = signatureSvg(svgPath);
    if (!svg || checkStrictSvg(svg) || !press.take()) return;
    reachedPay.current = false;
    holdKey.current = sealKey(
      myKey,
      doc.documentId,
      mine.map((f) => f.id),
    );
    setPhase({ k: 'working', step: 'preparing', slow: false });
    const keys: SealKeys = {
      createSignature: (a) => apiContext.wallet.createSignature(a as never) as Promise<{ signature: number[] }>,
      createAction: (a) => apiContext.wallet.createAction(a as never) as Promise<{ txid?: string; tx?: number[] }>,
    };
    let fee: number | null = null;
    try {
      const out = await nativeSignAndSeal({
        documentId: doc.documentId,
        fieldIds: mine.map((f) => f.id),
        svg,
        api,
        keys,
        store: localStore(),
        ledger: localLedger(),
        identityKey: myKey,
        coins: coins(),
        onStep: (s) => {
          if (s === 'paying') reachedPay.current = true;
          setPhase({ k: 'working', step: s, slow: false });
        },
        // "Checking your coins — …" under "Finding a fresh coin…" once the wait passes 2 s.
        onSlow: (s) => setPhase((p) => (p.k === 'working' && p.step === s ? { ...p, slow: true } : p)),
        // EVERY seal: the payment sheet, then Face ID / passcode, or the wallet password (sealApproval.ts). Nothing
        // here reads a spending limit, allowance or one-click setting, so nothing can skip it.
        approve: async (prepared) => {
          // The wallet's own fee model, with prepare's reference. bit-sign's estFeeSats (1 sat/byte, ~10× the real
          // fee) is logged only.
          fee = estimateSealFee(
            mine.map((f) => f.id),
            prepared.ref || ref,
            satsPerKb(),
          );
          console.info('[nativeSeal] fee estimate', { wallet: fee, bitsign: prepared.estFeeSats });
          setNamedFee(fee);
          const p = prepared as typeof prepared & { origHash?: string };
          const info: SealSheetInfo = {
            title: prepared.title || doc.title,
            ticker: ticker.replace(/^\$/, '').toUpperCase(),
            docHash: typeof p.origHash === 'string' && p.origHash ? p.origHash.slice(0, 8) : fingerprint,
            handle: shownHandle,
            feeSats: fee,
            blocks: mine.length,
          };
          try {
            return await approveSealWithSheet(info, {
              showSheet,
              // ⚠ NEVER A SILENT PASS (security P0, 3 Nov 2026): no Face ID / passcode here means the wallet password.
              confirm: () =>
                approveSealPayment(sealReason(info), 'bChatX', { auth: nativeAuth, passwordAuth: askWalletPassword }),
            });
          } finally {
            setSheet(null);
          }
        },
      });
      setPhase({ k: 'done', out, roomError: null, feeSats: fee });
      await tellRoom(out, fee);
      const c = await client();
      const signed = await fetchSignedCopy((path) => c.request('GET', path), ticker, [doc.documentId, out.signatureId]);
      if (signed) setSignedHtml(signed);
    } catch (e) {
      const text = e instanceof NativeSealError || e instanceof Error ? e.message : 'The seal did not finish.';
      // This version is out of date (another party sealed since it opened): offer the latest, never the same button.
      if (e instanceof NativeSealError && e.code === 'newer_version') {
        setPhase({ k: 'stale', text });
        return;
      }
      if (retryAllowed(e, reachedPay.current)) {
        // Nothing was paid: the button comes back, drawing kept, with plain words.
        press.release();
        setPhase({ k: 'ready', note: text });
        return;
      }
      setPhase({ k: 'failed', text });
    }
  };

  /** The room's "signed and sealed" steps (nativeSeal.nativeRoomSteps). Safe to retry: the seal is already on chain. */
  const tellRoom = async (out: NativeSealOutcome, feeSats: number | null) => {
    if (!doc) return;
    try {
      const c = await client();
      await nativeRoomSteps((path, body) => c.request('POST', path, body), ticker, doc.manifest, out);
      setPhase({ k: 'done', out, roomError: null, feeSats });
    } catch (e) {
      setPhase({ k: 'done', out, roomError: e instanceof Error ? e.message : 'The room did not update.', feeSats });
    }
  };

  const progress: SealProgress | null = phase.k === 'working' ? phase.step : phase.k === 'done' ? 'done' : null;
  const showPad = phase.k === 'ready' && !!doc && mine.length > 0 && view === 'pad';
  // The hash the desktop shows (the QR's), to compare; the opened bytes' own fingerprint when there is none.
  const docHash = docHashFor(ticker, docId);
  const shortDocHash = docHash ? shortHash(docHash) : `#${fingerprint}`;

  return (
    // Full screen above the Dock / tab bar (z-[100]): the pad's buttons sat under the bottom bar (iPhone, 3 Nov 2026).
    <div
      className="bw-seal-noselect fixed inset-0 z-[500] flex min-h-0 flex-col pt-[env(safe-area-inset-top)]"
      data-testid="native-seal-page"
      style={{ background: '#0b0b0d', color: '#e4e4e7', ...NO_SELECT }}
    >
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid rgba(245,184,0,0.35)' }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg px-2 py-1 text-[14px]"
          style={{ color: '#a1a1aa' }}
        >
          ‹ Back
        </button>
        <div className="min-w-0 flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#F5B800' }}>
            Review &amp; sign
          </div>
          <div className="text-[14px] font-semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {doc?.title ?? 'Document'}
          </div>
        </div>
        {fingerprint && (
          <span className="font-mono text-[11px]" style={{ color: '#71717a' }}>
            #{fingerprint}
          </span>
        )}
      </div>
      {doc && (
        <iframe
          title="Document"
          sandbox=""
          srcDoc={inertHtml(signedHtml ?? doc.html)}
          className="min-h-0 w-full flex-1"
          style={{ background: '#fff', border: 0 }}
        />
      )}
      <div
        className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
        style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
      >
        {phase.k === 'loading' && <p className="text-[14px]">Opening the document…</p>}
        {(phase.k === 'error' || phase.k === 'failed') && (
          <p role="alert" className="text-[14px]" style={{ color: '#fca5a5' }}>
            {phase.text}
          </p>
        )}
        {phase.k === 'notice' && (
          <p
            role="status"
            aria-live="polite"
            className="text-[14px]"
            data-testid="seal-notice"
            style={{ color: '#e4e4e7' }}
          >
            {phase.text}
          </p>
        )}
        {phase.k === 'stale' && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-[14px]" style={{ color: '#fca5a5' }}>
              {phase.text}
            </p>
            <button
              type="button"
              data-testid="seal-open-latest"
              onClick={() => {
                kept.current = undefined;
                setView('pad');
                setReload((n) => n + 1);
              }}
              className="min-h-12 w-full rounded-lg text-[15px] font-semibold"
              style={{ background: '#F5B800', color: '#0b0b0d' }}
            >
              Open the latest version
            </button>
          </div>
        )}
        {phase.k === 'ready' && doc && mine.length === 0 && (
          <p className="text-[14px]">This document has no signature block for ${me}.</p>
        )}
        {showPad && (
          <SignaturePad
            key={reload}
            sideways
            initialStrokes={kept.current}
            saveLabel={sealButtonLabel(namedFee ?? estFee)}
            onCancel={() => navigate(-1)}
            onReview={(strokes) => {
              kept.current = strokes;
              setView('review');
            }}
            onSave={(path, strokes) => {
              kept.current = strokes;
              void signAndSeal(path);
            }}
            note={
              phase.k === 'ready' && phase.note
                ? phase.note
                : `Signed as $${shownHandle} · you approve the fee on the next screen`
            }
            details={
              <div className="bw-sigpad-doc">
                <strong>{doc?.title ?? 'Document'}</strong>
                <span>Document {shortDocHash}</span>
                <span>
                  Sign as {mine[0].name || `$${me}`}
                  {mine.length > 1 ? ` (fills ${mine.length} blocks)` : ''}
                </span>
              </div>
            }
          />
        )}
        {phase.k === 'ready' && doc && mine.length > 0 && (
          <div>
            {phase.note && (
              <p role="alert" className="mb-2 text-[14px]" style={{ color: '#fca5a5' }}>
                {phase.note}
              </p>
            )}
            <button
              type="button"
              data-testid="seal-back-to-pad"
              onClick={() => setView('pad')}
              className="min-h-12 w-full rounded-lg text-[15px] font-semibold"
              style={{ background: '#F5B800', color: '#0b0b0d' }}
            >
              {kept.current?.length ? 'Back to signing' : DRAW_HINT}
            </button>
            <p className="mt-1 text-center text-[12px]" style={{ color: '#a1a1aa' }}>
              Document {shortDocHash} · signing as ${shownHandle}
            </p>
          </div>
        )}
        {progress && (
          <ul role="status" aria-live="polite" className="mt-2 flex flex-col gap-0.5" data-testid="seal-progress">
            {sealProgress(progress, phase.k === 'working' && phase.slow).map((l) => (
              <li
                key={l.text}
                className="text-[14px]"
                style={{ color: l.done ? '#6ee7b7' : '#e4e4e7', fontWeight: l.done ? 500 : 400 }}
              >
                {l.text}
              </li>
            ))}
          </ul>
        )}
        {phase.k === 'done' && (
          <div>
            <p className="mt-1 text-[13px]" style={{ color: '#e4e4e7' }} data-testid="seal-receipt">
              {sealReceipt({
                actualFeeSats: phase.out.feeSats,
                estFeeSats: phase.feeSats,
                handle: shownHandle,
                txid: phase.out.txid,
                usdPerBsv: price.status === 'ok' ? price.usdPerBsv : null,
              })}
            </p>
            <p className="mt-0.5 text-[12px]" style={{ color: '#a1a1aa' }}>
              {signedHtml ? 'Showing your signed copy.' : 'Your signed copy is in the room.'}
            </p>
            {phase.roomError && (
              <div className="mt-2 flex items-center gap-2">
                <p role="alert" className="min-w-0 flex-1 text-[13px]" style={{ color: '#fca5a5' }}>
                  Sealed on chain, but the room did not update ({phase.roomError}).
                </p>
                <button
                  type="button"
                  onClick={() => void tellRoom(phase.out, phase.feeSats)}
                  className="min-h-11 rounded-lg px-4 text-[14px]"
                  style={{ border: '1px solid rgba(245,184,0,0.5)', color: '#F5B800' }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {sheet && (
        <SealPaySheet
          info={sheet.info}
          price={price}
          busy={sheet.busy}
          onApprove={() => sheet.answer(true)}
          onCancel={() => sheet.answer(false)}
        />
      )}
    </div>
  );
};

export default NativeSealPage;
