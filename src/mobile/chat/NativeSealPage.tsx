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
import { approveSealPaymentResult, approveSealWithSheetOutcome } from './sealApproval';
import { reportSealFailure, type SealSettled } from './sealReport';
import { currentAccountId, sendOrQueueReport } from '../agent/reportSend';
import { localLedger, localStore } from './sealStore';
import { createRetryHold } from './sealRetryHold';
import { useSheetPrice } from '../../components/DollarAmount';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { SealPaySheet } from './SealPaySheet';
import {
  DRAW_HINT,
  SEAL_AGAIN_LABEL,
  SLOW_COMMIT_MS,
  TRY_AGAIN_LABEL,
  createPressGuard,
  estimateSealFee,
  openingNotice,
  primaryHandleFrom,
  retryAllowed,
  retryDrawingFits,
  retryLabel,
  sealButtonLabel,
  sealProgress,
  sealReason,
  sealReceipt,
  type SealProgress,
  type SealSheetInfo,
} from './sealScreen';
import {
  CHECKING_PAYMENT_LINE,
  CHECKING_PAYMENT_NOTE,
  HELD_FOR_REOPEN_MESSAGE,
  NOT_SENT_AFTER_CHECK_MESSAGE,
  NativeSealError,
  RESTORED_DRAWING_MESSAGE,
  abandonSeal,
  drawingUsable,
  PAY_AGAIN_CONFIRM_MESSAGE,
  SEAL_AGAIN_PAY_AGAIN_LABEL,
  archiveRefusedSeal,
  heldSupportMessage,
  heldTooLong,
  paidAgainDrawingMessage,
  paidRefusedMessage,
  refusedRecordFor,
  sealBusyElsewhere,
  settleUnsureSeal,
  type RecoverResult,
  inertHtml,
  fetchSignedCopy,
  accountHandles,
  handlesFromErrorBody,
  namesLoadError,
  myFields,
  nativeRoomSteps,
  nativeSignAndSeal,
  recoverNativeSeals,
  sealKey,
  sealStateHere,
  signedFieldIds,
  warmSealRoutes,
  type SealDrawing,
  type SealFailure,
  type SealResume,
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
import { sealRef } from './sealCheck';
import { SignaturePad } from '../signature/SignaturePad';
import type { SigStroke } from '../signature/signature';
import { checkStrictSvg, signatureSvg } from '../pair/bitsign';

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
  /**
   * Nothing was paid (owner, 23 Nov 2026: "having to do it twice is not good"): plain words, the SAME drawing, and one
   * tap ("Try again", or "Seal again" on reopen). With the kept seal (drawing.resume) only approval and payment run.
   */
  | { k: 'retry'; text: string; drawing: SealDrawing; label: string }
  /** An unclear payment: the wallet's own storage is being checked on this screen (nativeSeal.settleUnsureSeal). */
  | { k: 'checking' }
  /** Still unknown after the check: held on this phone, finished on the next open. No Sign button. */
  | { k: 'held'; text: string }
  /**
   * Paid, and bit-sign refused to record it (review of #560 N2): support with its reference, and an explicit, confirmed
   * "Seal again (you'll pay again)" that archives the old record (never deletes it).
   */
  | { k: 'paid_refused'; text: string; nonce: string; confirming: boolean }
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
  const recovery = useRef<Promise<RecoverResult[]> | null>(null);
  /** The key a press is holding; released on unmount when its payment has not started (nativeSeal.abandonSeal). */
  const holdKey = useRef<string | null>(null);
  /** False once the page has unmounted: the on-screen check stops at its next step (settleUnsureSeal `stopped`). */
  const mounted = useRef(true);
  /**
   * The kept session while the Try again / Seal again screen is up (sealRetryHold.ts, review of #560 L2): given back to
   * bit-sign when the page unmounts or after 2 minutes on the screen, whichever is first. The drawing stays.
   */
  const retryHold = useRef(
    createRetryHold({
      cancel: (nonce) => void api('cancel', { nonce }).catch(() => undefined),
      // Never cancel a session another window is paying on (review of #560 L4).
      busyElsewhere: (key) => sealBusyElsewhere(localStore(), key, Date.now()),
      drawings: () => localStore().drawings,
      onGiveBack: (d) => setPhase((p) => (p.k === 'retry' && p.drawing.key === d.key ? { ...p, drawing: d } : p)),
    }),
  ).current;
  useEffect(
    () => () => {
      mounted.current = false;
      if (holdKey.current) abandonSeal(holdKey.current);
      retryHold.giveBack();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // This account's records only; key-less ones (saved before 6 Nov) here, on the document opened under it.
        recovery.current = recoverNativeSeals(api, localStore(), p.documentId, localLedger(), txLookup(), {
          identityKey: myKey,
          keyless: true,
        });
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
  // A failed list is never swallowed (P0, 16 Nov 2026: a 503 from the server hid the $boase block and the page only said
  // "no signature block"): names in a 5xx error body still count, a 401 signs in again once, and anything else is shown.
  const [handles, setHandles] = useState<string[]>([]);
  const [namesError, setNamesError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const list = async (c: BchatClient) => accountHandles(await c.request('GET', '/api/bitsign/me/handles'));
      try {
        let names: string[];
        try {
          names = await list(await client());
        } catch (e) {
          if (!(e instanceof ChatApiError)) throw e;
          // Names in the body count only for a server error (5xx), never for a 401 / 4xx (handlesFromErrorBody).
          const fromBody = handlesFromErrorBody(e);
          if (fromBody.length) names = fromBody;
          else if (e.status === 401) {
            const s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(apiContext));
            saveSession(s);
            names = await list(new BchatClient(defaultHttp(isNative), s));
          } else throw e;
        }
        if (live) {
          setHandles(names);
          setNamesError(null);
        }
      } catch (e) {
        if (live) setNamesError(namesLoadError(e));
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
      const state = sealStateHere(myKey, doc.documentId, ids, localStore(), localLedger());
      // Paid and refused for good (N2): its own words and way out, never "Already sealed" or "being recorded".
      const refusedRec = state === 'refused' ? refusedRecordFor(localStore(), myKey, doc.documentId, ids) : null;
      if (refusedRec) {
        setPhase((p) =>
          p.k !== 'ready' && p.k !== 'notice'
            ? p
            : { k: 'paid_refused', text: paidRefusedMessage(refusedRec), nonce: refusedRec.nonce, confirming: false },
        );
        // Recovery on open may still record it (inside bit-sign's window): look again once it ends.
        return recovered ? null : { text: '', busy: true };
      }
      let n = openingNotice(state, recovered);
      // Still not recorded a day after it was saved: a reference for support. Never cancelled (review of #560 M2).
      const stuck = recovered && n ? heldTooLong(localStore(), myKey, doc.documentId, ids, Date.now()) : null;
      if (stuck) n = { text: heldSupportMessage(stuck), busy: false };
      // A seal that proved unpaid kept its drawing: one tap, "Seal again", never a redraw (owner, 23 Nov 2026). Its
      // kept session (if any) is held only while this screen is up (L2).
      const d = n ? null : keptDrawing(key);
      if (d) retryHold.hold(d);
      setPhase((p) =>
        p.k !== 'ready' && p.k !== 'notice' && p.k !== 'paid_refused'
          ? p
          : n
            ? { k: 'notice', text: n.text, busy: n.busy }
            : d
              ? {
                  k: 'retry',
                  // A paid seal set aside for support (L6) is never "Nothing was paid".
                  text: d.paidRef ? paidAgainDrawingMessage(d.paidRef) : RESTORED_DRAWING_MESSAGE,
                  drawing: d,
                  label: SEAL_AGAIN_LABEL,
                }
              : { k: 'ready' },
      );
      return n;
    };
    if (show(false)?.busy)
      void (recovery.current ?? Promise.resolve([]))
        .catch(() => [])
        .then(() => {
          if (live) show(true);
        });
    return () => {
      live = false;
    };
  }, [doc, mine, myKey, retryHold]);
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
    // And wake bChatX's seal routes while he draws (nativeSeal.warmSealRoutes: ~1 s cold start each, 7 Nov 2026).
    // No session token on these: a warm-up needs none.
    const warm = new BchatClient(defaultHttp(isNative));
    warmSealRoutes((path) => warm.request('GET', path, undefined, false));
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

  // The reference the seal's output will carry, read from the document on screen as nativeSeal reads it (sealCheck.ts).
  const ref = useMemo(() => (doc ? sealRef(doc.html, doc.documentId) : ''), [doc]);
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

  /** A drawing kept on this device for this seal, when it is still usable and still a strict signature SVG. */
  const keptDrawing = (key: string): SealDrawing | null => {
    try {
      const d = localStore().drawings?.get(key);
      return drawingUsable(d, key, Date.now()) && !checkStrictSvg(d.svg) ? d : null;
    } catch {
      return null;
    }
  };

  /** "Report to b" (b_feedback, or the outbox when it can't go now): why a seal's payment failed, scrubbed. */
  const reportFailure = (f: SealFailure, settled?: SealSettled) =>
    reportSealFailure(f, {
      settled,
      send: (text) => sendOrQueueReport(apiContext, currentAccountId(chromeStorageService), text),
    });

  /** The pad's Sign & seal: its path → the same strict 1000 × 250 SVG the bitsign bridge sends (pair/bitsign.ts). */
  const pressSeal = (svgPath: string) => {
    const svg = signatureSvg(svgPath);
    if (svg) void signAndSeal(svg);
  };

  /**
   * The one button. Disabled after the first press; it only comes back after a failure that paid nothing, and then
   * with the SAME drawing (and, while its session lasts, the same prepared, composed and signed seal: `resume`).
   */
  const signAndSeal = async (svg: string, resume?: SealResume | null) => {
    if (press.held() || !doc || !mine.length) return;
    // Checked before use, a kept drawing read back from storage included.
    if (!svg || checkStrictSvg(svg) || !press.take()) return;
    reachedPay.current = false;
    // The seal owns the kept session from here (its 2-minute give-back stops).
    retryHold.take();
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
    /** The failure nativeSeal reported (reported again with what the on-screen check found). */
    let failure: SealFailure | null = null;
    try {
      const out = await nativeSignAndSeal({
        documentId: doc.documentId,
        // The bytes on screen: the record the wallet signs must name exactly these (sealCheck.ts).
        documentHtml: doc.html,
        fieldIds: mine.map((f) => f.id),
        svg,
        resume: resume ?? null,
        // The room's $TICKER: on held records and in the Signed list's SealRecorded hook.
        ticker,
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
        onFailure: (f) => {
          failure = f;
          reportFailure(f);
        },
        // EVERY seal: the payment sheet, then Face ID / passcode, or the wallet password (sealApproval.ts). Nothing
        // here reads a spending limit, allowance or one-click setting, so nothing can skip it.
        satsPerKb: satsPerKb(),
        approve: async (prepared, feeSats) => {
          // The wallet's own fee model over the document on screen (nativeSeal.ts; never prepare's `ref`), and the
          // most the seal will pay. bit-sign's estFeeSats (1 sat/byte, ~10× the real fee) is logged only.
          fee = feeSats;
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
            // Which prompt did not complete is said in plain words ("Face ID didn't complete. Nothing was paid.").
            return await approveSealWithSheetOutcome(info, {
              showSheet,
              // ⚠ NEVER A SILENT PASS (security P0, 3 Nov 2026): no Face ID / passcode here means the wallet password.
              confirm: () =>
                approveSealPaymentResult(sealReason(info), 'bChatX', {
                  auth: nativeAuth,
                  passwordAuth: askWalletPassword,
                }),
            });
          } finally {
            setSheet(null);
          }
        },
      });
      await finishDone(out, fee);
    } catch (e) {
      const text = e instanceof NativeSealError || e instanceof Error ? e.message : 'The seal did not finish.';
      // This version is out of date (another party sealed since it opened): offer the latest, never the same button.
      // Paid, but bit-sign wouldn't record it: support, and the explicit pay-again way out (N2).
      if (e instanceof NativeSealError && e.code === 'paid_refused' && e.nonce) {
        setPhase({ k: 'paid_refused', text, nonce: e.nonce, confirming: false });
        return;
      }
      if (e instanceof NativeSealError && e.code === 'newer_version') {
        setPhase({ k: 'stale', text });
        return;
      }
      // An unclear payment: never left at "failed". Its transaction is looked for in the wallet's own storage right
      // here, a few times over about half a minute (nativeSeal.settleUnsureSeal); this never pays.
      let unpaidAfterCheck: SealDrawing | null | false = false;
      if (e instanceof NativeSealError && e.code === 'pending_recovery' && e.nonce) {
        setPhase({ k: 'checking' });
        const settled = await settleUnsureSeal({
          api,
          store: localStore(),
          nonce: e.nonce,
          lookup: txLookup(),
          ledger: localLedger(),
          // Left: the check stops; the record stays and recovery on the next open applies the same rule.
          stopped: () => !mounted.current,
        });
        if (!mounted.current) return;
        if (failure) reportFailure(failure, settled.k);
        if (settled.k === 'recorded') return void (await finishDone(settled.out, fee));
        if (settled.k === 'failed') {
          const r = refusedRecordFor(
            localStore(),
            myKey,
            doc.documentId,
            mine.map((f) => f.id),
          );
          return setPhase(
            r
              ? { k: 'paid_refused', text: paidRefusedMessage(r), nonce: r.nonce, confirming: false }
              : { k: 'failed', text: settled.message },
          );
        }
        // Still unknown: held. "We'll finish this automatically when you reopen it. Don't sign it again."
        if (settled.k === 'unknown') return setPhase({ k: 'held', text: HELD_FOR_REOPEN_MESSAGE });
        unpaidAfterCheck = settled.drawing ?? {
          key: holdKey.current ?? '',
          documentId: doc.documentId,
          identityKey: myKey,
          fieldIds: mine.map((f) => f.id),
          svg,
          savedAt: Date.now(),
        };
      }
      if (unpaidAfterCheck || retryAllowed(e, reachedPay.current)) {
        // Nothing was paid: the button comes back with plain words and the SAME drawing (no redraw).
        press.release();
        const d = unpaidAfterCheck || (e instanceof NativeSealError ? (e.drawing ?? null) : null);
        if (d) {
          retryHold.hold(d);
          setPhase({
            k: 'retry',
            text: unpaidAfterCheck ? NOT_SENT_AFTER_CHECK_MESSAGE : text,
            drawing: d,
            label: TRY_AGAIN_LABEL,
          });
        } else setPhase({ k: 'ready', note: text });
        return;
      }
      setPhase({ k: 'failed', text });
    }
  };

  /**
   * "Seal again (you'll pay again)", confirmed (N2): the refused paid record goes to the support list (never deleted),
   * then the pad, with the same drawing when it was kept.
   */
  const payAgain = (nonce: string) => {
    if (!doc || !mine.length) return;
    if (!archiveRefusedSeal(localStore(), nonce)) {
      setPhase({ k: 'failed', text: "Couldn't set the first payment aside for support. Nothing was changed." });
      return;
    }
    const d = keptDrawing(currentKey);
    if (d) {
      retryHold.hold(d);
      setPhase({
        k: 'retry',
        text: d.paidRef ? paidAgainDrawingMessage(d.paidRef) : PAY_AGAIN_CONFIRM_MESSAGE,
        drawing: d,
        label: SEAL_AGAIN_LABEL,
      });
    } else setPhase({ k: 'ready' });
  };

  /** "Draw again" instead of the kept drawing: it is forgotten here, and its kept session (if any) given back. */
  const drawAgain = (d: SealDrawing) => {
    try {
      localStore().drawings?.remove(d.key);
    } catch {
      /* storage blocked */
    }
    retryHold.giveBack();
    kept.current = undefined;
    setView('pad');
    setPhase({ k: 'ready' });
  };

  /** Sealed: the receipt, the room's steps and the signed copy. Never throws (the seal itself is done). */
  const finishDone = async (out: NativeSealOutcome, feeSats: number | null) => {
    retryHold.take();
    setPhase({ k: 'done', out, roomError: null, feeSats });
    try {
      await tellRoom(out, feeSats);
      const c = await client();
      const signed = await fetchSignedCopy((path) => c.request('GET', path), ticker, [
        doc?.documentId ?? '',
        out.signatureId,
      ]);
      if (signed) setSignedHtml(signed);
    } catch {
      /* the signed copy is in the room */
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

  /**
   * This account's key for this seal now. The retry screen's drawing must still be its own (review of #560 L3): after
   * an account switch it goes back to the pad (the other account's drawing stays stored for it; its session goes back).
   */
  const currentKey =
    doc && mine.length
      ? sealKey(
          myKey,
          doc.documentId,
          mine.map((f) => f.id),
        )
      : '';
  const backToPad = () => {
    retryHold.giveBack();
    kept.current = undefined;
    setView('pad');
    setPhase({ k: 'ready' });
  };
  useEffect(() => {
    if (phase.k === 'retry' && !retryDrawingFits(phase.drawing, currentKey)) backToPad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, currentKey]);

  const progress: SealProgress | null = phase.k === 'working' ? phase.step : phase.k === 'done' ? 'done' : null;
  const showPad = phase.k === 'ready' && !!doc && mine.length > 0 && view === 'pad';
  // The hash the desktop shows (the QR's), to compare; the opened bytes' own fingerprint when there is none.
  const docHash = docHashFor(ticker, docId);
  // The desktop's short code: # and the first 8 of the hash.
  const shortDocHash = docHash ? `#${docHash.slice(0, 8)}` : `#${fingerprint}`;

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
        {phase.k === 'checking' && (
          <p role="status" aria-live="polite" className="text-[14px]" data-testid="seal-checking">
            {CHECKING_PAYMENT_LINE}
            <span className="mt-1 block text-[12px]" style={{ color: '#a1a1aa' }}>
              {CHECKING_PAYMENT_NOTE}
            </span>
          </p>
        )}
        {phase.k === 'paid_refused' && (
          <div className="flex flex-col gap-2" data-testid="seal-paid-refused">
            <p role="alert" className="text-[14px]" style={{ color: '#fca5a5' }}>
              {phase.text}
            </p>
            {phase.confirming ? (
              <>
                <p className="text-[13px]" style={{ color: '#e4e4e7' }}>
                  {PAY_AGAIN_CONFIRM_MESSAGE}
                </p>
                <button
                  type="button"
                  data-testid="seal-pay-again-confirm"
                  onClick={() => payAgain(phase.nonce)}
                  className="min-h-12 w-full rounded-lg text-[15px] font-semibold"
                  style={{ background: '#F5B800', color: '#0b0b0d' }}
                >
                  Yes, seal again and pay again
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ ...phase, confirming: false })}
                  className="min-h-11 w-full rounded-lg text-[14px]"
                  style={{ border: '1px solid rgba(245,184,0,0.5)', color: '#F5B800' }}
                >
                  Not now
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="seal-pay-again"
                onClick={() => setPhase({ ...phase, confirming: true })}
                className="min-h-11 w-full rounded-lg text-[14px]"
                style={{ border: '1px solid rgba(245,184,0,0.5)', color: '#F5B800' }}
              >
                {SEAL_AGAIN_PAY_AGAIN_LABEL}
              </button>
            )}
          </div>
        )}
        {phase.k === 'held' && (
          <p role="status" aria-live="polite" className="text-[14px]" data-testid="seal-held">
            {phase.text}
          </p>
        )}
        {phase.k === 'retry' && (
          <div className="flex flex-col gap-2" data-testid="seal-retry">
            <p role="alert" className="text-[14px]" style={{ color: '#fca5a5' }}>
              {phase.text}
            </p>
            <img
              alt="Your signature"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(phase.drawing.svg)}`}
              className="h-16 w-full rounded-lg object-contain"
              style={{ background: '#fff' }}
            />
            <button
              type="button"
              data-testid="seal-try-again"
              onClick={() =>
                // Still this account's seal (L3): an account switch on this screen goes back to the pad.
                retryDrawingFits(phase.drawing, currentKey)
                  ? void signAndSeal(phase.drawing.svg, phase.drawing.resume)
                  : backToPad()
              }
              className="min-h-12 w-full rounded-lg text-[15px] font-semibold"
              style={{ background: '#F5B800', color: '#0b0b0d' }}
            >
              {retryLabel(phase.label, namedFee ?? estFee)}
            </button>
            <button
              type="button"
              data-testid="seal-draw-again"
              onClick={() => drawAgain(phase.drawing)}
              className="min-h-11 w-full rounded-lg text-[14px]"
              style={{ border: '1px solid rgba(245,184,0,0.5)', color: '#F5B800' }}
            >
              Draw again
            </button>
          </div>
        )}
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
          <>
            <p className="text-[14px]">This document has no signature block for ${me}.</p>
            {namesError && <p className="text-[13px] opacity-80">{namesError}</p>}
          </>
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
              pressSeal(path);
            }}
            note={
              phase.k === 'ready' && phase.note
                ? phase.note
                : `Signed as $${shownHandle} · you approve the fee on the next screen`
            }
            turnInfo={{
              title: doc?.title ?? 'Document',
              code: docHash ? `#${docHash.slice(0, 8)}` : `#${fingerprint}`,
              signer: `$${shownHandle}`,
            }}
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
        {!showPad && phase.k === 'ready' && doc && mine.length > 0 && (
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
