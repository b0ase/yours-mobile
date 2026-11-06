import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Hash, Utils } from '@bsv/sdk';
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
  primaryHandleFrom,
  padHasSignature,
  retryAllowed,
  sealButtonLabel,
  sealProgress,
  sealReason,
  sealReceipt,
  type SealProgress,
  type SealSheetInfo,
} from './sealScreen';
import {
  ALREADY_SEALED_MESSAGE,
  NativeSealError,
  inertHtml,
  fetchSignedCopy,
  accountHandles,
  myFields,
  nativeRoomSteps,
  nativeSignAndSeal,
  recoverNativeSeals,
  sealedHere,
  signedFieldIds,
  strokesToSvg,
  type PadPoint,
  type PendingSeal,
  type PendingSealStore,
  type SealLedger,
  type NativeSealOutcome,
  type SealApi,
  type SealKeys,
  type SealStep,
  type SigField,
} from './nativeSeal';
import { openPendingForLink, type RoomReq } from './nativeSealSource';
import { docHashFor } from './signLink';

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
/** Documents sealed from this device (the double-pay guard, nativeSeal.SealLedger). Newest last, at most 500. */
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
  | { k: 'done'; out: NativeSealOutcome; roomError: string | null; feeSats: number | null };

export const NativeSealPage = () => {
  const { ticker = '', doc: docId = '' } = useParams();
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  /** The pad's strokes and size (kept here so the one button can seal them). */
  const pad = useRef<{ strokes: PadPoint[][]; w: number; h: number }>({ strokes: [], w: 0, h: 0 });
  const [inked, setInked] = useState(false);
  /** Double press guard: set synchronously on the first press, cleared only when the button may come back. */
  const press = useRef(createPressGuard()).current;
  /** The payment step has started: from here a failure may have paid (no retry button). */
  const reachedPay = useRef(false);
  const [sheet, setSheet] = useState<{ info: SealSheetInfo; busy: boolean; answer: (ok: boolean) => void } | null>(
    null,
  );
  const price = useSheetPrice();
  const [signedHtml, setSignedHtml] = useState<string | null>(null);

  /** The wallet's silent bChatX session (Bearer); signs in with the wallet key when there is none. */
  const client = async (): Promise<BchatClient> => {
    let s = loadSession();
    if (!s) {
      s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(apiContext));
      saveSession(s);
    }
    return new BchatClient(defaultHttp(isNative), s);
  };

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
        // Sealed from this device already, or paid and waiting to be recorded: never a second seal (6 Nov 2026).
        if (sealedHere(p.documentId, localStore(), localLedger()))
          setPhase({ k: 'error', text: ALREADY_SEALED_MESSAGE });
        else setPhase({ k: 'ready' });
        void recoverNativeSeals(api, localStore(), p.documentId, localLedger());
      } catch (e) {
        if (live) setPhase({ k: 'error', text: e instanceof Error ? e.message : 'Could not open the document.' });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, docId]);

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
  const signAndSeal = async () => {
    if (press.held() || !doc || !mine.length || !padHasSignature(pad.current.strokes)) return;
    const svg = strokesToSvg(pad.current.strokes, pad.current.w, pad.current.h);
    if (!svg || !press.take()) return;
    reachedPay.current = false;
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
  const showPad = (phase.k === 'ready' || phase.k === 'working') && !!doc && mine.length > 0;
  const buttonOn = phase.k === 'ready' && inked;

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
        {phase.k === 'ready' && doc && mine.length === 0 && (
          <p className="text-[14px]">This document has no signature block for ${me}.</p>
        )}
        {showPad && (
          <div>
            {phase.k === 'ready' && phase.note && (
              <p role="alert" className="mb-2 text-[14px]" style={{ color: '#fca5a5' }}>
                {phase.note}
              </p>
            )}
            <SignaturePad
              label={`Sign as ${mine[0].name || `$${me}`}${mine.length > 1 ? ` (fills ${mine.length} blocks)` : ''}`}
              locked={phase.k !== 'ready'}
              onChange={(strokes, w, h) => {
                pad.current = { strokes, w, h };
                setInked(padHasSignature(strokes));
              }}
            />
            <button
              type="button"
              data-testid="sign-and-seal"
              disabled={!buttonOn}
              aria-disabled={!buttonOn}
              onClick={() => void signAndSeal()}
              className="mt-2 min-h-12 w-full rounded-lg text-[15px] font-semibold"
              style={{ background: '#F5B800', color: '#0b0b0d', opacity: buttonOn ? 1 : 0.45 }}
            >
              {sealButtonLabel(namedFee ?? estFee)}
            </button>
            {phase.k === 'ready' && !inked && (
              <p className="mt-1 text-center text-[12px]" style={{ color: '#a1a1aa' }}>
                {DRAW_HINT}
              </p>
            )}
            {phase.k === 'ready' && inked && (
              <p className="mt-1 text-center text-[12px]" style={{ color: '#a1a1aa' }}>
                Signed as ${shownHandle} · #{fingerprint} · you approve the fee on the next screen
              </p>
            )}
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

/**
 * The wallet's own finger pad: strokes → the web pad's exact SVG (nativeSeal.strokesToSvg). No Done step: the strokes
 * go up on every change and the page's one Sign & seal button seals them. Nothing may interrupt drawing: no
 * selection, callout, magnifier, context menu or scroll from a touch on the canvas.
 */
const SignaturePad = ({
  label,
  locked,
  onChange,
}: {
  label: string;
  locked: boolean;
  onChange: (strokes: PadPoint[][], width: number, height: number) => void;
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const strokes = useRef<PadPoint[][]>([]);
  const cur = useRef<PadPoint[] | null>(null);
  // React's touch listeners are passive, so preventDefault there is ignored: add real ones (passive: false).
  useEffect(() => {
    const c = ref.current;
    const w = wrap.current;
    if (!c || !w) return;
    const stop = (e: Event) => e.preventDefault();
    const opts: AddEventListenerOptions = { passive: false };
    c.addEventListener('touchstart', stop, opts);
    c.addEventListener('touchmove', stop, opts);
    w.addEventListener('contextmenu', stop);
    w.addEventListener('selectstart', stop);
    return () => {
      c.removeEventListener('touchstart', stop, opts);
      c.removeEventListener('touchmove', stop, opts);
      w.removeEventListener('contextmenu', stop);
      w.removeEventListener('selectstart', stop);
    };
  }, []);
  const pt = (e: React.PointerEvent<HTMLCanvasElement>): PadPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, pressure: e.pressure || 0.5 };
  };
  const draw = () => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = '#111';
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
    }
  };
  const changed = () => {
    const c = ref.current;
    onChange([...strokes.current], c?.clientWidth ?? 0, c?.clientHeight ?? 0);
  };
  return (
    <div ref={wrap} className="bw-seal-pad" data-testid="seal-pad" style={NO_SELECT}>
      <div className="mb-1 flex items-center gap-2 text-[13px]" style={{ color: '#a1a1aa' }}>
        <span className="min-w-0 flex-1">{label}</span>
        {!locked && (
          <button
            type="button"
            onClick={() => {
              strokes.current = [];
              draw();
              changed();
            }}
            className="min-h-9 rounded-lg px-3 text-[13px]"
            style={{ border: '1px solid rgba(255,255,255,0.15)' }}
          >
            Clear
          </button>
        )}
      </div>
      <canvas
        ref={(el) => {
          ref.current = el;
          if (el && el.width !== el.clientWidth) {
            el.width = el.clientWidth;
            el.height = el.clientHeight;
          }
        }}
        className="h-40 w-full rounded-lg"
        style={{ background: '#fff', touchAction: 'none', ...NO_SELECT, pointerEvents: locked ? 'none' : undefined }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          cur.current = [pt(e)];
          draw();
        }}
        onPointerMove={(e) => {
          if (!cur.current) return;
          cur.current.push(pt(e));
          draw();
        }}
        onPointerUp={() => {
          if (cur.current && cur.current.length > 1) strokes.current.push(cur.current);
          cur.current = null;
          draw();
          changed();
        }}
        onPointerCancel={() => {
          if (cur.current && cur.current.length > 1) strokes.current.push(cur.current);
          cur.current = null;
          draw();
          changed();
        }}
      />
    </div>
  );
};

export default NativeSealPage;
