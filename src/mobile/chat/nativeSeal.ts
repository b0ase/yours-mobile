import { Transaction, Utils } from '@bsv/sdk';
import { NATIVE_SEAL_ENABLED } from '../storeBuild';
import {
  SPENT_ELSEWHERE_SHORT_MESSAGE,
  SPENT_ELSEWHERE_STUCK_MESSAGE,
  classifySendError,
  type SendErrorKind,
} from '../../utils/sendErrors';
import { browserWakeClock, waitForCoinCheck, type WakeClock } from './coinWait';
import { WALL_TIMEOUT, withinWallClock } from '../../services/wallClock';
import { SEAL_MAX_SATS, SEAL_REF_MAX_CHARS, shortText } from '../../services/sealLimits';
import {
  SEAL_MISMATCH_MESSAGE,
  SEAL_PREPARE_MISMATCH_MESSAGE,
  checkComposed,
  checkPrepared,
  sealRef,
} from './sealCheck';
import { estimateSealFee, sealScriptFee } from './sealFee';

/**
 * NATIVE sign + seal of a bChatX room document, inside bWalletX (CTO / owner, 3 Nov 2026: "chat should be IN the
 * wallet"). Phone signing never goes through a web page: the dApp browser's approval stalled on "Waiting for
 * request…" (two live tests, 05:36Z and 05:57Z: prepare + compose reached the server, nothing after).
 *
 * The SAME protocol as bit-sign's web client (bit-sign src/lib/bwalletx-seal.ts `attempt`), with the wallet's OWN keys
 * instead of a BRC-100 round trip:
 *   POST /api/bitsign/nds/seal/prepare {documentId, fieldIds}           → nonce, identityKey, estFeeSats…
 *   POST /api/bitsign/nds/seal/compose {nonce, svg}                     → signing {protocolID,keyID,counterparty},
 *                                                                          recordCanonical, lockingScriptHex
 *   CHECK compose's answer (chat/sealCheck.ts): the wallet rebuilds the record and the output from the document on
 *     screen, the drawn signature, its own identity key and prepare's nonce, and signs / pays only for its own copy,
 *     and only when that copy's fee is within the one the sheet showed (worked out from the document, not prepare)
 *   wallet.createSignature(recordCanonical bytes)                       → attestation (hex)
 *   wallet.createAction(one 0-sat OP_RETURN output, acceptDelayedBroadcast:false) → txid + AtomicBEEF
 *   SAVE {nonce, txid, beefHex, attestation} locally (the money has moved)
 *   POST /api/bitsign/nds/seal/receipt {nonce, txid, attestation, beefHex} (≈5 s cap; any failure is ignored: the
 *                                                                          server's sweep finishes a receipt whose
 *                                                                          commit never lands)
 *   POST /api/bitsign/nds/seal/commit {nonce, attestation, txid, beefHex} (retry once on a network fault)
 *   on a refusal / lost commit: POST /api/bitsign/nds/seal/recover with the same body.
 * Authenticated with the wallet's silent bChatX session (Bearer, chat/chatSession.ts); the server checks the same
 * identity binding it checks for the web (the account's linked bWalletX key).
 *
 * PURE orchestration over injected deps: nativeSeal.test.ts drives the real order.
 */

export interface SealApiReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}
export type SealApi = (
  path: 'prepare' | 'compose' | 'receipt' | 'commit' | 'recover' | 'cancel',
  body: Record<string, unknown>,
) => Promise<SealApiReply>;

/** The two wallet calls this needs, from the wallet's own (no-prompt) interface. */
export interface SealKeys {
  createSignature(args: {
    protocolID: [0 | 1 | 2, string];
    keyID: string;
    counterparty: string;
    data: number[];
  }): Promise<{ signature: number[] }>;
  createAction(args: {
    description: string;
    outputs: { satoshis: number; lockingScript: string; outputDescription: string }[];
    options: { acceptDelayedBroadcast: boolean; randomizeOutputs: boolean };
  }): Promise<{ txid?: string; tx?: number[] }>;
}

export interface PendingSeal {
  documentId: string;
  nonce: string;
  txid: string;
  beefHex: string;
  attestation: string;
  savedAt: number;
  /** Who signed which blocks (sealKey). Missing on payments saved before 6 Nov 2026. */
  identityKey?: string;
  fieldIds?: string[];
  /**
   * The seal's OP_RETURN output script, on an UNSURE record (beefHex '': the payment may or may not have gone out).
   * Recovery looks the transaction up in this wallet's own storage by it (SealTxLookup).
   */
  lockingScriptHex?: string;
  /**
   * The drawn signature (the strict SVG the seal sent), kept with an UNSURE record only (owner, 23 Nov 2026: "having to
   * do it twice is not good"): if recovery proves nothing was paid, the page offers "Seal again" with this same drawing
   * instead of a redraw. On this device only; gone with the record (success or cancel).
   */
  svg?: string;
}

/**
 * Finds an unsure seal's transaction in this wallet's own storage (the page wires listActions + the services' BEEF).
 * `find`: the action whose outputs include the seal's script; { found: false } only when the wallet answered and has
 * no such action (then none was ever built: the toolbox stores an action before it signs or broadcasts it); null
 * when it could not tell. `beef`: the AtomicBEEF for a txid, null when it can't be had yet.
 */
export interface SealTxLookup {
  /** `sinceMs`: when the record was saved; the search starts a minute before it. */
  find(lockingScriptHex: string, sinceMs: number): Promise<{ found: false } | { found: true; txid: string } | null>;
  beef(txid: string): Promise<number[] | null>;
}

/** The wallet's listActions, as findSealAction needs it (BRC-100 ListActionsArgs / ListActionsResult, narrowed). */
export type ListActionsFn = (args: {
  labels: string[];
  includeOutputs: boolean;
  includeOutputLockingScripts: boolean;
  limit: number;
  offset: number;
}) => Promise<{
  totalActions: number;
  actions: { txid: string; outputs?: { lockingScript?: string }[] }[];
}>;

/** One listActions page while looking for a seal. */
export const SEAL_LOOKUP_PAGE = 100;

/**
 * The seal's action in this wallet's own storage, by its OP_RETURN output script, made since `sinceMs` − 1 minute
 * (toolbox BRC-114 label "action time from <ms>"), paged to the end. Searched TWICE: the ordinary list, which omits
 * actions marked failed, and the failed ones (toolbox specOpFailedActions, read only: never 'unfail', which rewrites
 * their status). ARC can still mine a "failed" transaction, so one found there is NOT "none built".
 * { found: false } only when BOTH lists answered to the end with no match; any error (a storage that rejects the time
 * filter, a closed database) → null, and the seal stays held.
 */
export async function findSealAction(
  listActions: ListActionsFn,
  lockingScriptHex: string,
  sinceMs: number,
  failedLabel: string,
): Promise<{ found: false } | { found: true; txid: string } | null> {
  const want = lockingScriptHex.toLowerCase();
  const from = `action time from ${Math.max(0, Math.floor(sinceMs - 60_000))}`;
  try {
    for (const labels of [[from], [from, failedLabel]]) {
      for (let offset = 0; offset < 1_000_000; offset += SEAL_LOOKUP_PAGE) {
        const r = await listActions({
          labels,
          includeOutputs: true,
          includeOutputLockingScripts: true,
          limit: SEAL_LOOKUP_PAGE,
          offset,
        });
        const hit = r.actions.find((a) => a.outputs?.some((o) => o.lockingScript?.toLowerCase() === want));
        if (hit?.txid) return { found: true, txid: hit.txid };
        if (r.actions.length < SEAL_LOOKUP_PAGE || offset + r.actions.length >= r.totalActions) break;
      }
    }
    return { found: false };
  } catch {
    return null;
  }
}
export interface PendingSealStore {
  list(): PendingSeal[];
  save(p: PendingSeal): void;
  remove(nonce: string): void;
  /** Drawings kept for one-tap "Seal again" after a seal that proved unpaid (same device store; optional). */
  drawings?: SealDrawingStore;
}

/**
 * ONE SIGNATURE PER DOCUMENT (owner, 23 Nov 2026: "having to do it twice is not good"). What a seal that proved unpaid
 * keeps so "Try again" / "Seal again" never asks for a second drawing: the drawing itself, and (while bit-sign's signing
 * session lasts) the prepared + composed seal and its attestation, so a retry only approves and pays.
 */
export interface SealResume {
  /** sealKey of the seal it belongs to: used only for that signer, document and blocks. */
  key: string;
  /** The strict SVG the record was composed with. */
  svg: string;
  prepared: PreparedSeal;
  /** compose's answer, checked AGAIN against the document on screen (checkComposed) before it is reused. */
  composed: Record<string, unknown>;
  /** createSignature over the composed record (hex). Never reported or logged. */
  attestation: string;
  /** When bit-sign's signing session for the nonce ends (ms since epoch). */
  expiresAt: number;
}

export interface SealDrawing {
  key: string;
  documentId: string;
  identityKey: string;
  fieldIds: string[];
  /** The strict SVG (pair/bitsign.signatureSvg). The page checks it again (checkStrictSvg) before using it. */
  svg: string;
  savedAt: number;
  /** Present while the nonce is kept for a pay-only retry; dropped once that session is cancelled or expires. */
  resume?: SealResume;
}

export interface SealDrawingStore {
  get(key: string): SealDrawing | null;
  save(d: SealDrawing): void;
  remove(key: string): void;
}

/** bit-sign SEAL_NONCE_TTL_MS: a prepared seal can be composed and committed for this long. */
export const SEAL_NONCE_TTL_MS = 10 * 60_000;
/** A kept nonce is reused only with at least this long left (approval + payment + commit). */
export const RESUME_MARGIN_MS = 90_000;
/** A kept drawing is offered for this long at most; then the pad starts empty. */
export const DRAWING_MAX_AGE_MS = 24 * 60 * 60_000;
/** A drawing bigger than this is not kept on the device (the pad's own cap is 8 KB of path). */
export const DRAWING_MAX_CHARS = 16 * 1024;

/** Pure: is this stored drawing still usable for this seal? */
export const drawingUsable = (d: SealDrawing | null | undefined, key: string, now: number): d is SealDrawing =>
  !!d &&
  d.key === key &&
  typeof d.svg === 'string' &&
  d.svg.length > 0 &&
  d.svg.length <= DRAWING_MAX_CHARS &&
  typeof d.savedAt === 'number' &&
  now - d.savedAt < DRAWING_MAX_AGE_MS;

const drawingsOf = (store: PendingSealStore): SealDrawingStore | undefined => {
  try {
    return store.drawings;
  } catch {
    return undefined;
  }
};
const forgetDrawing = (store: PendingSealStore, key: string) => {
  try {
    drawingsOf(store)?.remove(key);
  } catch {
    /* storage blocked */
  }
};
const keepDrawing = (store: PendingSealStore, d: SealDrawing): SealDrawing => {
  try {
    if (d.svg.length <= DRAWING_MAX_CHARS) drawingsOf(store)?.save(d);
  } catch {
    /* storage blocked: the page still has it in memory */
  }
  return d;
};

/**
 * What this device has sealed (or seen sealed by another party at commit). The double-pay guard (owner's iPhone, 6 Nov
 * 2026: doc 2ddfb0ce was sealed from the phone AND the desktop and paid twice). A seal is keyed by WHO signs WHICH
 * blocks of WHICH document (sealKey): another account on this phone, or other blocks of the same document, still sign.
 * bit-sign never rewrites a document under its id (every version, part-signed copy and seal is a new row), so the key
 * stays true. It is only a fast hint: the server's own already_sealed answer is the authority. bit-sign cannot yet say
 * a seal is in flight on ANOTHER device of the same account, so the in-flight part of this guard is this device's only.
 */
export interface SealLedger {
  has(key: string): boolean;
  add(key: string): void;
}

/** Who (identity key) signs which blocks (field ids, any order) of which document. */
export const sealKey = (identityKey: string, documentId: string, fieldIds: readonly string[]): string =>
  `${(identityKey || '').toLowerCase()}|${documentId}|${[...new Set(fieldIds)].sort().join(',')}`;

/** Shown instead of a second seal. */
export const ALREADY_SEALED_MESSAGE = 'Already sealed. Nothing more to sign or pay for this document.';
/** bit-sign signer_race (compose): another party sealed since this seal started. Nothing was signed or paid. */
export const NEWER_VERSION_MESSAGE =
  'Someone sealed this document since you opened it. Open the latest version and sign again. Nothing was signed or paid.';
/** bit-sign signer_busy: the same account is sealing it on another device right now. */
export const BUSY_ELSEWHERE_MESSAGE =
  'This document is being sealed on another of your devices. Nothing was signed or paid here.';
/** Not paid: the seal took longer than bit-sign's signing session (the app slept between approval and payment). */
export const EXPIRED_HOLD_MESSAGE =
  'Not sealed: this took too long and the signing session ended. Nothing was paid. Tap Sign & seal again.';
/** Not paid: the page was left before the payment started. */
export const LEFT_PAGE_MESSAGE = 'Not sealed: you left the page. Nothing was paid.';

/**
 * How long a seal may hold its key on this device at most, on the wall clock, whatever happens to it (a hung
 * createAction, a frozen app). bit-sign's signing session lasts 10 minutes, so a seal still running after that can no
 * longer be recorded anyway.
 */
export const SEAL_HOLD_MAX_MS = 10 * 60_000;

type Hold = { paying: boolean; abandoned: false | 'left' | 'expired' };
/** Seals running now in this app, by sealKey (a second page or route for the same seal is refused). */
const inFlight = new Map<string, Hold>();

/**
 * The page was left: release the seal's hold so the document can be sealed again, but ONLY if its payment has not
 * started (then it never will: the abandoned seal stops before paying). Once it is paying, the hold stays until it
 * settles or SEAL_HOLD_MAX_MS pass. True when released.
 */
export const abandonSeal = (key: string): boolean => {
  const h = inFlight.get(key);
  if (!h || h.paying) return false;
  h.abandoned = 'left';
  inFlight.delete(key);
  return true;
};

export type SealHere = 'none' | 'in_flight' | 'recording' | 'unsure' | 'sealed';

/**
 * What this device knows about one seal: running now, paid and waiting to be recorded (PendingSealStore), recorded
 * (the ledger), or nothing. A saved payment from before keys were stored matches by document id alone.
 */
export const sealStateHere = (
  identityKey: string,
  documentId: string,
  fieldIds: readonly string[],
  store: PendingSealStore,
  ledger?: SealLedger | null,
): SealHere => {
  if (!documentId) return 'none';
  const key = sealKey(identityKey, documentId, fieldIds);
  if (inFlight.has(key)) return 'in_flight';
  try {
    const saved = store
      .list()
      .filter(
        (p) =>
          p.documentId === documentId &&
          (p.identityKey === undefined ||
            p.fieldIds === undefined ||
            sealKey(p.identityKey, p.documentId, p.fieldIds) === key),
      );
    // A payment with its transaction in hand is recorded by /recover; one without (an unclear failure) only waits.
    if (saved.some((p) => p.beefHex)) return 'recording';
    if (saved.length) return 'unsure';
  } catch {
    /* unreadable store: the other checks stand */
  }
  try {
    if (ledger?.has(key)) return 'sealed';
  } catch {
    /* unreadable ledger: the server's checks remain */
  }
  return 'none';
};

const markSealed = (ledger: SealLedger | null | undefined, key: string) => {
  try {
    ledger?.add(key);
  } catch {
    /* storage blocked: the server's own checks remain */
  }
};

/**
 * createAction failed and it is NOT certain that nothing went out (a broadcast was tried, a network error or timeout
 * during it, a txid in the answer). The nonce is never cancelled then, and no retry is offered.
 */
export const MAY_HAVE_PAID_MESSAGE = 'This seal may have been paid — it will be checked and recorded.';

// ── Not paid: plain words, and the drawing is kept (owner, 23 Nov 2026) ─────────────────────────────────────────────
/** The sheet was approved but Face ID / Touch ID / the passcode did not complete. */
export const FACE_ID_NOT_PAID_MESSAGE = "Face ID didn't complete. Nothing was paid.";
/** No phone prompt here, and the wallet password sheet was cancelled or wrong. */
export const PASSWORD_NOT_PAID_MESSAGE = "The wallet password wasn't confirmed. Nothing was paid.";
/** Cancel on the sheet of a retry (the signature was already made; nothing more is). */
export const DECLINED_NOT_PAID_MESSAGE = 'Not sealed: you cancelled. Nothing was paid.';
/** createAction refused before anything was built or sent, with no plainer words of its own. */
export const REFUSED_NOT_PAID_MESSAGE = 'The payment was refused before anything was sent. Nothing was paid.';
/** The wallet's own storage has no seal transaction after an unclear failure: nothing went out. */
export const NOT_SENT_AFTER_CHECK_MESSAGE = "The payment didn't go out. Nothing was paid.";
/** On reopen, a seal that proved unpaid: the drawing is offered again. */
export const RESTORED_DRAWING_MESSAGE = "Your last seal didn't go through. Nothing was paid. Your signature is kept.";
/** Still unknown after the on-screen check: held, and finished by recovery on the next open. */
export const HELD_FOR_REOPEN_MESSAGE = "We'll finish this automatically when you reopen it. Don't sign it again.";

/**
 * What approve() answered. true / 'approved' → pay; false / 'declined' → Cancel on the sheet; the rest → the sheet was
 * approved but the phone's prompt (or the wallet password) did not complete. None of them pays.
 */
export type SealApproval = boolean | 'approved' | 'declined' | 'device_auth_failed' | 'password_failed';

/** What a failed seal reports (chat/sealReport.ts): where it stopped and the raw error, never shown as is. */
export interface SealFailure {
  outcome: 'pending_recovery' | 'not_paid';
  step: SealStep;
  error: unknown;
}

const tellFailure = (input: { onFailure?: (f: SealFailure) => void }, f: SealFailure) => {
  try {
    input.onFailure?.(f);
  } catch {
    /* a report never changes the seal */
  }
};

/** The words for a createAction that proved nothing went out: the wallet's own, always saying nothing was paid. */
const notPaidText = (e: unknown): string => {
  const info = classifySendError(e, 'send');
  if (info.kind === 'cancelled') return 'You cancelled the payment. Nothing was paid.';
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (!raw) return REFUSED_NOT_PAID_MESSAGE;
  return /nothing (was|has been) (sent|paid)/i.test(raw) ? raw : `${raw.replace(/\s*$/, '')} Nothing was paid.`;
};
/** How long a cancel may take at most before the seal goes on without it (it is best effort). */
export const CANCEL_TIMEOUT_MS = 3_000;

/**
 * The failure kinds where the wallet itself says nothing was built, signed or broadcast (utils/sendErrors.ts
 * moneyMoved 'no'). 'network' is NOT here: a network error during createAction can be one during its broadcast.
 */
const NOTHING_SENT_KINDS = new Set<SendErrorKind>([
  'cancelled',
  'locked',
  'insufficient-funds',
  'spent-elsewhere',
  'payment-refused',
  'device-not-active',
  'other-extension',
  'worker-restarted',
  'broadcast-failed',
  // NOT 'storage-full' (QuotaExceeded) or 'storage-remote-failing': the toolbox can throw them from a storage write
  // AFTER the broadcast, and a cancel + retry there would lose the first seal and pay twice. Unsure instead.
]);

/**
 * Pure: does this createAction failure PROVE no seal transaction exists or went out? Only then is the nonce cancelled
 * (bit-sign never recovers a cancelled nonce). Any doubt, a txid in the answer, or an unknown kind → false.
 */
export const provablyNotPaid = (e: unknown): boolean => {
  if (e && typeof e === 'object' && typeof (e as { txid?: unknown }).txid === 'string') return false;
  // The extension's USB-key gate (services/usbPresence.ts gateWalletOnUsb) refuses on the PAGE, before the call is even
  // sent to the background: nothing can have been built (23 Nov 2026 audit of what createAction throws).
  if (e instanceof Error && (e.name === 'UsbKeyAbsentError' || /^Insert your USB key to continue$/.test(e.message)))
    return true;
  const info = classifySendError(e, 'send');
  return info.moneyMoved === 'no' && !info.txid && NOTHING_SENT_KINDS.has(info.kind);
};

/**
 * bit-sign POST /seal/cancel {nonce}: this seal will never be paid, so a retry can prepare and compose again without
 * signer_busy. Best effort, once, at most CANCEL_TIMEOUT_MS: 404 (an older server, or not ours), 409 (being
 * recorded / already used), 503 (seal_v2_unavailable), a network error or a timeout are all ignored. Never throws.
 */
async function cancelSeal(api: SealApi, nonce: string, clock?: WakeClock): Promise<void> {
  try {
    const r = await withinWallClock(
      api('cancel', { nonce }).catch(() => null),
      CANCEL_TIMEOUT_MS,
      { clock },
    );
    if (r && r !== WALL_TIMEOUT && !r.ok && r.status !== 404 && r.status !== 503)
      console.info('[nativeSeal] cancel not taken (harmless):', r.status, r.body.code ?? '');
  } catch {
    /* harmless */
  }
}

export interface PreparedSeal {
  nonce: string;
  ref: string;
  title: string;
  identityKey: string;
  estFeeSats: number;
}

export type SealStep =
  | 'preparing'
  | 'approving'
  | 'healing'
  | 'composing'
  | 'signing'
  | 'paying'
  | 'committing'
  | 'recovering';

export class NativeSealError extends Error {
  /** A seal that paid nothing: the drawing (and, while its session lasts, the seal itself) for Try again. */
  readonly drawing?: SealDrawing;
  /** pending_recovery from an unclear payment: the held record's nonce, for the on-screen check (settleUnsureSeal). */
  readonly nonce?: string;
  constructor(
    message: string,
    readonly code:
      | 'already_sealed'
      | 'newer_version'
      | 'refused'
      | 'cancelled'
      | 'pending_recovery'
      | 'failed'
      | 'spent_elsewhere'
      | 'not_paid'
      | 'orphaned',
    readonly status = 0,
    extra: { drawing?: SealDrawing; nonce?: string } = {},
  ) {
    super(message);
    this.name = 'NativeSealError';
    if (extra.drawing) this.drawing = extra.drawing;
    if (extra.nonce) this.nonce = extra.nonce;
  }
}

export interface NativeSealOutcome {
  signatureId: string;
  txid: string;
  docHash: string;
  complete: boolean;
  sealed: boolean;
  recovered?: boolean;
  /** The fee the seal transaction actually paid (inputs − outputs, read from its AtomicBEEF), when it could be read. */
  feeSats?: number;
}

/**
 * Pure: the fee a transaction paid, from its AtomicBEEF (the ancestors it carries give each input's amount). Null when
 * the bytes don't parse or an input's amount is missing: the caller then shows its estimate, labelled "about".
 */
export function feeFromAtomicBeef(tx: number[] | undefined): number | null {
  if (!tx?.length) return null;
  try {
    const t = Transaction.fromAtomicBEEF(tx);
    let into = 0;
    for (const i of t.inputs) {
      const sats = i.sourceTransaction?.outputs[i.sourceOutputIndex]?.satoshis;
      if (typeof sats !== 'number') return null;
      into += sats;
    }
    const out = t.outputs.reduce((n, o) => n + (o.satoshis ?? 0), 0);
    return into >= out ? into - out : null;
  } catch {
    return null;
  }
}

/**
 * The seal steps the press waits on, warmed when the pad shows (warmSealRoutes).
 * Owner's iPhone, 7 Nov 2026 (doc dbb9beec): bit-sign's Vercel logs show prepare (10:22:05) and commit (10:22:36)
 * each starting a cold function instance, about a second apiece, inside the seal. Never cancel or recover.
 */
export const SEAL_WARM_ROUTES = ['prepare', 'compose', 'commit'] as const;

/**
 * Wake bChatX's seal routes while he draws, so the press doesn't pay their cold starts: one GET each (the routes are
 * POST-only, so the answer is a 405 and nothing is read or written; only the function instance starts). Fire and
 * forget: returns at once, never throws, never rejects, and the seal itself never depends on it.
 */
export function warmSealRoutes(get: (path: string) => Promise<unknown>): void {
  for (const r of SEAL_WARM_ROUTES)
    void Promise.resolve()
      .then(() => get(`/api/bitsign/nds/seal/${r}`))
      .catch(() => undefined);
}

/** The broadcast receipt may hold the seal this long at most; then commit goes ahead regardless. */
export const RECEIPT_TIMEOUT_MS = 5_000;
/**
 * "In progress" (bit-sign a1cc86a1): HTTP 429 + Retry-After, body { code: 'commit_in_progress', retryAfter }.
 * Another request (an earlier attempt, or the server's sweep) is recording this very payment. Never final: keep the
 * saved payment, wait Retry-After, ask recover again. Matched by 429 OR the code at any status. A 409 is now a real
 * refusal (replayed, signer_race).
 */
export const isInProgress = (r: Pick<SealApiReply, 'status' | 'body'>): boolean =>
  r.status === 429 || r.body.code === 'commit_in_progress';
/** Recover is asked at most this many times in one press; then the entry waits for the next open or the sweep. */
export const IN_PROGRESS_TRIES = 3;
export const DEFAULT_RETRY_AFTER_S = 15;
/** The wait the server asked for (body retryAfter, seconds; the Retry-After header is not visible here). */
export const retryAfterMs = (r: Pick<SealApiReply, 'body'>): number => {
  const s = Number(r.body.retryAfter);
  return (Number.isFinite(s) && s > 0 ? Math.min(s, 120) : DEFAULT_RETRY_AFTER_S) * 1000;
};
/** After payment: keep the saved payment for later (network fault, server fault, in progress)? */
const keepsPayment = (r: Pick<SealApiReply, 'status' | 'body'>): boolean =>
  r.status === 0 || r.status >= 500 || isInProgress(r);
/** Another party sealed the document first: the payment is recorded against the session, nothing to retry. */
const isOrphaned = (b: Record<string, unknown>): boolean => b.orphaned === true;

/**
 * The broadcast receipt (bit-sign /seal/receipt, 3 Nov 2026): tells the server the seal is paid the moment
 * createAction returns, so its sweep can finish the seal if this phone dies before commit. Fire-and-await with a
 * short cap; whatever happens (503 receipts_unavailable before the migration, 404/409/410, a network error, a
 * timeout) the seal goes on to commit as before. Never throws.
 */
async function sendReceipt(api: SealApi, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      api('receipt', body).then((r) => {
        if (!r.ok) console.warn('[nativeSeal] receipt not recorded (commit goes ahead)', r.status, r.body.code ?? '');
      }),
      new Promise<void>((resolve) => {
        t = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (e) {
    console.warn('[nativeSeal] receipt failed (commit goes ahead)', e instanceof Error ? e.message : e);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** "Nothing sent" answers where a re-tap can't succeed (review 24 L2): shown as the background words them. */
const SEAL_RETRY_FUTILE = [SPENT_ELSEWHERE_STUCK_MESSAGE, SPENT_ELSEWHERE_SHORT_MESSAGE];

/** Shown when the seal's payment hit a coin already spent elsewhere. Plain words, never the toolbox text. */
export const SEAL_SPENT_MESSAGE = 'A coin was already spent on another device. Tap Seal & pay again.';

/**
 * Pure: did the seal's payment fail because a coin was already spent (same seed on another device)? Owner's iPhone,
 * 3 Nov 2026 14:37Z, board minute 010: "Undelayed createAction or signAction results require review. rejected by the
 * network as invalid; broadcaster said: UTXO_SPENT (70) … already spent by tx …" was shown raw. The payment runs
 * through the background's createAction, which already heals the rejected inputs and retries ONCE when that is safe
 * (services/spentRetry.ts); what reaches this page is the outcome as text, so it is matched here, not retried again.
 */
export const isSpentCoinError = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  // Review 24 L2: two "nothing sent" answers where tapping again can't succeed keep the background's own words: the
  // coins couldn't be updated (a re-tap picks the same dead coin; it says to Resync coins), or what is left is too
  // little for this payment.
  if (SEAL_RETRY_FUTILE.some((t) => m.includes(t))) return false;
  return /UTXO_SPENT|already spent|missing ?inputs|spent elsewhere|spent on another device/i.test(m);
};

const toHex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

async function call(api: SealApi, path: Parameters<SealApi>[0], body: Record<string, unknown>) {
  const r = await api(path, body);
  if (!r.ok) {
    const code = typeof r.body.code === 'string' ? r.body.code : '';
    // Sealed already: never a second seal.
    if (code === 'already_sealed') throw new NativeSealError(ALREADY_SEALED_MESSAGE, 'already_sealed', r.status);
    // Another party sealed since this started (compose): this version is out of date; open the latest and sign again.
    if (code === 'signer_race') throw new NativeSealError(NEWER_VERSION_MESSAGE, 'newer_version', r.status);
    // Being sealed on another of this account's devices: a plain refusal, nothing signed or paid.
    if (code === 'signer_busy')
      throw new NativeSealError(
        typeof r.body.error === 'string' && r.body.error ? r.body.error : BUSY_ELSEWHERE_MESSAGE,
        'refused',
        r.status,
      );
    const msg =
      typeof r.body.error === 'string' && r.body.error ? r.body.error : `The seal ${path} step failed (${r.status}).`;
    throw new NativeSealError(msg, 'refused', r.status);
  }
  return r.body;
}

/** Shown when the seal's output would cost more than the sheet showed or a seal may. Nothing was signed or paid. */
export const SEAL_TOO_BIG_MESSAGE =
  'Not sealed: this seal would cost more than the fee you were shown. Nothing was signed or paid.';

/**
 * Sign and seal. `approve(prepared, feeSats)` is the ONE approval (the wallet's own sheet + Face ID), asked after
 * prepare (so it can show the fee and the reference) and before anything is signed or paid; false = cancelled, nothing
 * happens.
 */
export async function nativeSignAndSeal(input: {
  documentId: string;
  /** The document exactly as shown to the signer: what the signed record must name (chat/sealCheck.ts). */
  documentHtml: string;
  fieldIds: string[];
  svg: string;
  api: SealApi;
  keys: SealKeys;
  store: PendingSealStore;
  /** Seals recorded from this device (sealKey): one listed here is never sealed again (the double-pay guard). */
  ledger?: SealLedger | null;
  /** The wallet's identity key: part of the seal's key (another account on this phone signs on its own). */
  identityKey?: string;
  /** `feeSats`: the fee to show, from the document on screen (never prepare's `ref`); the seal never pays for more. */
  approve: (prepared: PreparedSeal, feeSats: number) => Promise<SealApproval>;
  /**
   * The seal kept by a failure that paid nothing (NativeSealError.drawing.resume): while bit-sign's session for its nonce
   * lasts, and when it is still for this signer, document, blocks, drawing and document text, the retry skips prepare,
   * compose and the signature, and only approves and pays. Otherwise its nonce is cancelled and the seal is prepared
   * again from the SAME drawing (no redraw).
   */
  resume?: SealResume | null;
  /** Told whenever a seal ends in pending_recovery or not_paid (chat/sealReport.ts reports it to b). */
  onFailure?: (f: SealFailure) => void;
  /** The wallet's own fee rate (sat/kB), the one its createAction pays (default 100). */
  satsPerKb?: number;
  /**
   * The coin check started when the pad opened (so the press pays straight away). Still running after approval →
   * step 'healing' ("Finding a fresh coin…") and wait for `done`, at most COIN_WAIT_CAP_MS on the wall clock
   * (coinWait.ts), and not at all when `storageBusy` says a backup heal or sync holds the storage locks. The in-flight
   * spent-coin retry in the background's createAction is the fallback either way.
   */
  coins?: { pending: () => boolean; done: Promise<unknown>; storageBusy?: () => Promise<boolean> };
  /** Tests: the clock the coin wait runs on (default: Date.now + the page's wake events). */
  clock?: WakeClock;
  onStep?: (s: SealStep) => void;
  /** A step has taken long enough to say why ('healing' after 2 s). */
  onSlow?: (s: SealStep) => void;
  now?: () => number;
  /** Tests: the receipt cap and the wait between commit_in_progress answers. */
  receiptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<NativeSealOutcome> {
  // ⚠ ONE SEAL PER SIGNER, DOCUMENT AND BLOCKS FROM THIS DEVICE: recorded, paid and being recorded, or running now.
  const key = sealKey(input.identityKey ?? '', input.documentId, input.fieldIds);
  if (sealStateHere(input.identityKey ?? '', input.documentId, input.fieldIds, input.store, input.ledger) !== 'none')
    throw new NativeSealError(ALREADY_SEALED_MESSAGE, 'already_sealed');
  const hold: Hold = { paying: false, abandoned: false };
  inFlight.set(key, hold);
  const release = () => {
    if (inFlight.get(key) === hold) inFlight.delete(key);
  };
  // Never held past SEAL_HOLD_MAX_MS on the wall clock, even by a seal that hangs: then it may not start paying either.
  let settle = () => undefined as void;
  const settled = new Promise<void>((r) => (settle = r));
  void withinWallClock(settled, SEAL_HOLD_MAX_MS, { clock: input.clock }).then((r) => {
    if (r !== WALL_TIMEOUT) return;
    // ⚠ PAYING: never let go on time (the app slept mid-payment, 6 Nov 2026). Its unsure record is saved; the hold
    // ends when createAction settles, or with the app, and then the record is resolved by recovery (SealTxLookup).
    if (hold.paying) return;
    hold.abandoned = 'expired';
    release();
  });
  try {
    const out = await signAndSealOnce(input, hold, key);
    markSealed(input.ledger, key);
    forgetDrawing(input.store, key);
    return out;
  } catch (e) {
    // Another party sealed first: the document is sealed, so it is never offered again from here either.
    if (e instanceof NativeSealError && e.code === 'orphaned') markSealed(input.ledger, key);
    // Sealed, or the person cancelled on the sheet: no drawing is kept for later.
    if (e instanceof NativeSealError && ['orphaned', 'already_sealed', 'failed'].includes(e.code))
      forgetDrawing(input.store, key);
    throw e;
  } finally {
    release();
    settle();
  }
}

/** The txid an unclear failure names, if any (kept with the held record for support; recovery needs the BEEF too). */
const txidIn = (e: unknown): string => {
  const own = e && typeof e === 'object' ? (e as { txid?: unknown }).txid : undefined;
  if (typeof own === 'string' && /^[0-9a-f]{64}$/i.test(own)) return own.toLowerCase();
  return '';
};

/**
 * An UNSURE record: the payment may have gone out. Saved BEFORE createAction (and again with a txid when one is
 * known), so a crash, a sleep or an unclear failure always leaves it on this phone; recovery resolves it.
 */
function saveUnsure(
  input: Parameters<typeof nativeSignAndSeal>[0],
  nonce: string,
  attestation: string,
  lockingScriptHex: string,
  txid = '',
) {
  try {
    input.store.save({
      documentId: input.documentId,
      nonce,
      txid,
      beefHex: '',
      attestation,
      savedAt: (input.now ?? Date.now)(),
      identityKey: input.identityKey ?? '',
      fieldIds: [...input.fieldIds],
      lockingScriptHex,
      // The drawing goes with the held record: if recovery proves nothing was paid, "Seal again" reuses it.
      ...(input.svg.trim().length <= DRAWING_MAX_CHARS ? { svg: input.svg.trim() } : {}),
    });
  } catch {
    /* storage blocked: the in-flight hold and the server's checks remain */
  }
}

/** When the prepared seal's session ends: prepare's expiresAt, else SEAL_NONCE_TTL_MS from when it was prepared. */
const sessionEnd = (prepared: PreparedSeal, preparedAt: number): number => {
  const t = Date.parse(String((prepared as { expiresAt?: unknown }).expiresAt ?? ''));
  return Number.isFinite(t) ? Math.min(t, preparedAt + SEAL_NONCE_TTL_MS) : preparedAt + SEAL_NONCE_TTL_MS;
};

/**
 * Pure: may this kept seal be paid as it is? Only for the same signer, document, blocks and drawing, with time left on
 * its session, and when prepare and compose still check out against the document on screen NOW (sealCheck.ts).
 */
export const resumeUsable = (
  input: Pick<
    Parameters<typeof nativeSignAndSeal>[0],
    'documentId' | 'documentHtml' | 'fieldIds' | 'svg' | 'identityKey'
  >,
  r: SealResume | null | undefined,
  now: number,
): boolean => {
  if (!r || typeof r !== 'object' || !r.prepared || !r.composed || typeof r.attestation !== 'string') return false;
  if (r.key !== sealKey(input.identityKey ?? '', input.documentId, input.fieldIds)) return false;
  if (r.svg !== input.svg.trim() || !r.attestation) return false;
  if (!(now < r.expiresAt - RESUME_MARGIN_MS)) return false;
  if (checkPrepared(r.prepared, { documentHtml: input.documentHtml, identityKey: input.identityKey ?? '' }))
    return false;
  return checkComposed(r.composed, {
    documentId: input.documentId,
    documentHtml: input.documentHtml,
    svg: r.svg,
    fieldIds: input.fieldIds,
    identityKey: input.identityKey ?? '',
    nonce: r.prepared.nonce,
    ...(typeof (r.prepared as { ts?: unknown }).ts === 'string' ? { ts: (r.prepared as { ts?: string }).ts } : {}),
  }).ok;
};

async function signAndSealOnce(
  input: Parameters<typeof nativeSignAndSeal>[0],
  hold: Hold,
  key: string,
): Promise<NativeSealOutcome> {
  const step = (s: SealStep) => input.onStep?.(s);
  const now = input.now ?? Date.now;
  // ⚠ ONE SIGNATURE PER DOCUMENT: a seal kept by a failure that paid nothing is paid as it is while it can be; any
  // other kept seal (expired, another drawing or document) gives its session back and this one is prepared afresh.
  let reuse: SealResume | null = null;
  const kept = input.resume;
  if (kept) {
    if (resumeUsable(input, kept, now())) reuse = kept;
    else if (kept.prepared?.nonce) await cancelSeal(input.api, kept.prepared.nonce, input.clock);
  }
  let prepared: PreparedSeal;
  let expiresAt: number;
  if (reuse) {
    prepared = reuse.prepared;
    expiresAt = reuse.expiresAt;
  } else {
    step('preparing');
    const preparedAt = now();
    prepared = (await call(input.api, 'prepare', {
      documentId: input.documentId,
      fieldIds: input.fieldIds,
    })) as unknown as PreparedSeal;
    expiresAt = sessionEnd(prepared, preparedAt);
  }

  /** Set once createAction may have built or broadcast something: from then on the nonce is only cancelled on proof. */
  let mayHavePaid = false;
  try {
    return await afterPrepare(input, hold, key, prepared, expiresAt, reuse, () => (mayHavePaid = true));
  } catch (e) {
    // Nothing can have been paid (before the payment, or a refusal that proves it): free the nonce, unless the failure
    // kept this seal for a pay-only retry (its drawing carries the resume).
    const keptForRetry = e instanceof NativeSealError && !!e.drawing?.resume;
    if (!mayHavePaid && !keptForRetry) await cancelSeal(input.api, prepared.nonce, input.clock);
    throw e;
  }
}

async function afterPrepare(
  input: Parameters<typeof nativeSignAndSeal>[0],
  hold: Hold,
  key: string,
  prepared: PreparedSeal,
  expiresAt: number,
  reuse: SealResume | null,
  paymentMayHaveGoneOut: () => void,
): Promise<NativeSealOutcome> {
  const step = (s: SealStep) => input.onStep?.(s);
  const now = input.now ?? Date.now;
  const svg = input.svg.trim();
  /** The drawing a not-paid failure hands back (with the seal itself when it is kept for a pay-only retry). */
  const drawing = (resume?: SealResume): SealDrawing => ({
    key,
    documentId: input.documentId,
    identityKey: input.identityKey ?? '',
    fieldIds: [...input.fieldIds],
    svg,
    savedAt: now(),
    ...(resume ? { resume } : {}),
  });
  // ⚠ THE WALLET DECIDES WHAT IT SIGNS (sealCheck.ts): prepare must be for this document and this wallet.
  const preparedWrong = checkPrepared(prepared, {
    documentHtml: input.documentHtml,
    identityKey: input.identityKey ?? '',
  });
  if (preparedWrong) {
    console.warn('[nativeSeal] prepare refused:', preparedWrong);
    throw new NativeSealError(SEAL_PREPARE_MISMATCH_MESSAGE, 'refused');
  }
  // ⚠ THE SHEET'S FEE IS THE WALLET'S OWN: from the reference the record will carry (the document's manifest), never
  // prepare's `ref`. A document whose seal would cost more than a seal may is refused before any sheet.
  const rate = input.satsPerKb ?? 100;
  const ref = sealRef(input.documentHtml, input.documentId);
  const shownFee = estimateSealFee(input.fieldIds, ref, rate);
  if (!shortText(ref, SEAL_REF_MAX_CHARS) || shownFee > SEAL_MAX_SATS) {
    console.warn('[nativeSeal] refused before approval: seal too big', { refChars: ref.length, shownFee });
    throw new NativeSealError(SEAL_TOO_BIG_MESSAGE, 'refused');
  }
  step('approving');
  // EVERY payment, a retry too: the sheet, then Face ID / passcode or the wallet password (sealApproval.ts).
  const answer = await input.approve(prepared, shownFee);
  if (answer !== true && answer !== 'approved') {
    // Nothing was paid. A kept seal stays kept (its nonce is not cancelled) unless the person said no on the sheet.
    const declined = answer === false || answer === 'declined';
    if (declined) forgetDrawing(input.store, key);
    const text = declined
      ? reuse
        ? DECLINED_NOT_PAID_MESSAGE
        : 'Not sealed: you cancelled. Nothing was signed or paid.'
      : answer === 'password_failed'
        ? PASSWORD_NOT_PAID_MESSAGE
        : FACE_ID_NOT_PAID_MESSAGE;
    throw new NativeSealError(text, 'cancelled', 0, { drawing: drawing(declined ? undefined : (reuse ?? undefined)) });
  }

  if (input.coins?.pending()) {
    step('healing');
    const why = await waitForCoinCheck({
      done: input.coins.done,
      storageBusy: input.coins.storageBusy,
      clock: input.clock ?? browserWakeClock(),
      onSlow: () => input.onSlow?.('healing'),
    });
    if (why !== 'done') console.info('[nativeSeal] paying without waiting for the coin check:', why);
  }

  let composed: Record<string, unknown>;
  if (reuse) composed = reuse.composed;
  else {
    step('composing');
    composed = await call(input.api, 'compose', { nonce: prepared.nonce, svg });
  }
  // ⚠ NOTHING FROM COMPOSE IS SIGNED OR PAID FOR AS SENT: the protocol, key id and counterparty are fixed, the record is
  // rebuilt from this document and must match byte for byte, and the output is the wallet's own copy (sealCheck.ts).
  // A kept seal is checked again here, against the document on screen now.
  const checked = checkComposed(composed, {
    documentId: input.documentId,
    documentHtml: input.documentHtml,
    svg,
    fieldIds: input.fieldIds,
    identityKey: input.identityKey ?? '',
    nonce: prepared.nonce,
    ...(typeof (prepared as { ts?: unknown }).ts === 'string' ? { ts: (prepared as { ts?: string }).ts } : {}),
  });
  if (!checked.ok) {
    console.warn('[nativeSeal] compose refused:', checked.why);
    throw new NativeSealError(SEAL_MISMATCH_MESSAGE, 'refused');
  }
  const { signing, recordCanonical, lockingScriptHex } = checked;
  // ⚠ NEVER MORE THAN THE SHEET SAID: the output the wallet rebuilt, by the same fee model, within the approved fee.
  const scriptFee = sealScriptFee(lockingScriptHex, rate);
  if (scriptFee > shownFee || scriptFee > SEAL_MAX_SATS) {
    console.warn('[nativeSeal] compose refused: fee over the approved one', { scriptFee, shownFee });
    throw new NativeSealError(SEAL_TOO_BIG_MESSAGE, 'refused');
  }

  let attestation: string;
  if (reuse) attestation = reuse.attestation;
  else {
    step('signing');
    const { signature } = await input.keys.createSignature({
      protocolID: signing.protocolID,
      keyID: signing.keyID,
      counterparty: signing.counterparty,
      data: Array.from(new TextEncoder().encode(recordCanonical)),
    });
    attestation = toHex(signature);
  }
  /** This seal, kept for a pay-only retry when the payment proves it went nowhere. */
  const resume: SealResume = { key, svg, prepared, composed, attestation, expiresAt };

  // Left (abandonSeal) or held too long: stop here, before any money moves. From here the hold stays until settled.
  if (hold.abandoned)
    throw new NativeSealError(hold.abandoned === 'left' ? LEFT_PAGE_MESSAGE : EXPIRED_HOLD_MESSAGE, 'cancelled');
  // ⚠ BEFORE ANY MONEY MOVES: an unsure record, so nothing that happens next can leave this seal unaccounted for.
  saveUnsure(input, prepared.nonce, attestation, lockingScriptHex);
  hold.paying = true;
  step('paying');
  let paid: Awaited<ReturnType<SealKeys['createAction']>>;
  try {
    paid = await input.keys.createAction({
      description: 'bit-sign: sign and seal a document',
      outputs: [
        { satoshis: 0, lockingScript: lockingScriptHex, outputDescription: 'Document seal (OP_RETURN, hashes only)' },
      ],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    });
  } catch (e) {
    console.warn('[nativeSeal] pay failed', e instanceof Error ? e.message : e);
    if (provablyNotPaid(e)) {
      // Refused before anything went out: nothing paid, the unsure record goes. The nonce, the composed record and the
      // attestation are KEPT (not cancelled) so Try again only approves and pays: one signature per document.
      input.store.remove(prepared.nonce);
      const kept = keepDrawing(input.store, drawing(resume));
      tellFailure(input, { outcome: 'not_paid', step: 'paying', error: e });
      if (isSpentCoinError(e)) throw new NativeSealError(SEAL_SPENT_MESSAGE, 'spent_elsewhere', 0, { drawing: kept });
      throw new NativeSealError(notPaidText(e), 'not_paid', 0, { drawing: kept });
    }
    // ⚠ ANY DOUBT: it may have gone out. Never cancel the nonce, never offer a retry; this seal is held on this phone
    // (with the drawing) until its transaction is found in the wallet's own storage, or proved never built.
    paymentMayHaveGoneOut();
    if (txidIn(e)) saveUnsure(input, prepared.nonce, attestation, lockingScriptHex, txidIn(e));
    tellFailure(input, { outcome: 'pending_recovery', step: 'paying', error: e });
    throw new NativeSealError(MAY_HAVE_PAID_MESSAGE, 'pending_recovery', 0, { nonce: prepared.nonce });
  }
  if (!paid?.txid || !paid.tx) {
    // A txid with no transaction (or neither): it may well have gone out. The unsure record stays (with the txid).
    paymentMayHaveGoneOut();
    const t = typeof paid?.txid === 'string' && /^[0-9a-f]{64}$/i.test(paid.txid) ? paid.txid.toLowerCase() : '';
    if (t) saveUnsure(input, prepared.nonce, attestation, lockingScriptHex, t);
    tellFailure(input, {
      outcome: 'pending_recovery',
      step: 'paying',
      error: new Error(t ? 'createAction answered a txid without its transaction' : 'createAction answered no txid'),
    });
    throw new NativeSealError(MAY_HAVE_PAID_MESSAGE, 'pending_recovery', 0, { nonce: prepared.nonce });
  }
  paymentMayHaveGoneOut();
  const txid = paid.txid.toLowerCase();
  const beefHex = toHex(paid.tx);
  const feeSats = feeFromAtomicBeef(paid.tx);

  // ⚠ PERSIST BEFORE COMMIT: from here on the seal is paid for.
  input.store.save({
    documentId: input.documentId,
    nonce: prepared.nonce,
    txid,
    beefHex,
    attestation,
    savedAt: (input.now ?? Date.now)(),
    identityKey: input.identityKey ?? '',
    fieldIds: [...input.fieldIds],
  });

  step('committing');
  const body = { nonce: prepared.nonce, attestation, txid, beefHex };
  // The receipt first (same body as commit), then commit as before whatever the receipt answered.
  await sendReceipt(input.api, body, input.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS);
  let out: Record<string, unknown> | null = null;
  let lastErr = '';
  /** Set by an in-progress answer: wait this long before asking recover. */
  let waitMs = 0;
  for (let i = 0; i < 2 && !out; i++) {
    try {
      const r = await input.api('commit', body);
      // 200 (with idempotent:true when the sweep already finished it) or an orphaned result (success:false): done.
      if (r.ok) out = r.body;
      else {
        lastErr = typeof r.body.error === 'string' ? r.body.error : `Commit failed (${r.status}).`;
        // In progress (the sweep is finishing this very seal): wait Retry-After, then recover reads its result.
        if (isInProgress(r)) waitMs = retryAfterMs(r);
        // A refusal (409 replayed / signer_race…) will not change on a plain retry: recover gives the final word.
        break;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'network error'; // retry once with the same nonce + txid
    }
  }
  let recovered = false;
  if (!out) {
    step('recovering');
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < IN_PROGRESS_TRIES && !out; i++) {
      if (waitMs) await sleep(waitMs);
      waitMs = 0;
      let r: SealApiReply;
      try {
        r = await input.api('recover', body);
      } catch {
        break; // unreachable: kept on the phone
      }
      if (r.ok) {
        out = r.body;
        recovered = true;
      } else if (isInProgress(r)) {
        // Kept on the phone; never re-prepared or paid again. Ask again after the server's Retry-After.
        lastErr = typeof r.body.error === 'string' ? r.body.error : 'being recorded right now';
        if (i < IN_PROGRESS_TRIES - 1) waitMs = retryAfterMs(r);
      } else if (keepsPayment(r)) {
        break; // network / server fault: kept for the next open
      } else {
        // A definitive refusal (4xx other than 429): retrying later will not help.
        input.store.remove(prepared.nonce);
        throw new NativeSealError(
          typeof r.body.error === 'string' ? r.body.error : 'The seal could not be recorded.',
          'failed',
          r.status,
        );
      }
    }
  }
  if (out && isOrphaned(out)) {
    input.store.remove(prepared.nonce);
    throw new NativeSealError(
      typeof out.message === 'string' && out.message
        ? out.message
        : 'Another party sealed this document first. Your payment is recorded; nothing more to do.',
      'orphaned',
    );
  }
  if (!out) {
    tellFailure(input, {
      outcome: 'pending_recovery',
      step: 'committing',
      error: new Error(lastErr || 'not recorded'),
    });
    throw new NativeSealError(
      `Paid (${txid.slice(0, 12)}…) but not recorded yet${lastErr ? ` (${lastErr})` : ''}. It is saved on this phone and will be finished the next time you open this document.`,
      'pending_recovery',
    );
  }
  input.store.remove(prepared.nonce);
  return {
    signatureId: String(out.signatureId ?? ''),
    txid: String(out.txid || txid),
    docHash: String(out.docHash ?? ''),
    complete: !!out.complete,
    sealed: !!out.sealed,
    ...(recovered ? { recovered: true } : {}),
    ...(feeSats != null ? { feeSats } : {}),
  };
}

/**
 * An unsure record proved unpaid (the wallet never built its transaction): the record goes, the nonce is cancelled
 * (bit-sign never recovers a cancelled nonce) and the drawing is kept for "Seal again". Returns that drawing, if any.
 */
async function releaseUnpaid(
  api: SealApi,
  store: PendingSealStore,
  p: PendingSeal,
  now: () => number = Date.now,
): Promise<SealDrawing | null> {
  store.remove(p.nonce);
  await cancelSeal(api, p.nonce);
  if (!p.svg || !p.fieldIds || p.identityKey === undefined) return null;
  return keepDrawing(store, {
    key: sealKey(p.identityKey, p.documentId, p.fieldIds),
    documentId: p.documentId,
    identityKey: p.identityKey,
    fieldIds: [...p.fieldIds],
    svg: p.svg,
    savedAt: now(),
  });
}

/**
 * An unsure record (no BEEF): look its transaction up in this wallet's own storage. 'found': saved with its BEEF as an
 * ordinary paid record, which /recover then records (bit-sign records a paid seal even on a cancelled session).
 * 'not_found': the wallet answered and none was ever built (the record is left for the caller to release). 'unknown':
 * no lookup, no script, the lookup failed, or the BEEF is not to be had yet; held, never dropped while a transaction
 * might exist (a txid learnt is kept).
 */
async function lookUpUnsure(
  store: PendingSealStore,
  p: PendingSeal,
  lookup: SealTxLookup | undefined,
): Promise<'found' | 'not_found' | 'unknown'> {
  if (!lookup) return 'unknown';
  let txid = p.txid;
  if (!txid) {
    if (!p.lockingScriptHex) return 'unknown';
    const f = await lookup.find(p.lockingScriptHex, p.savedAt).catch(() => null);
    if (!f) return 'unknown';
    if (!f.found) return 'not_found';
    txid = f.txid.toLowerCase();
  }
  const tx = await lookup.beef(txid).catch(() => null);
  if (!tx?.length) {
    if (txid !== p.txid) store.save({ ...p, txid }); // keep what was learnt
    return 'unknown';
  }
  store.save({ ...p, txid, beefHex: toHex(tx) });
  return 'found';
}

/**
 * Finish seals saved on this phone (for this document, or all): paid-but-unrecorded ones through /recover, unsure ones
 * through the wallet's own storage first (lookUpUnsure). One the wallet never built is released as unpaid (its drawing
 * kept for "Seal again"). A seal running right now is left alone. Never throws.
 */
export async function recoverNativeSeals(
  api: SealApi,
  store: PendingSealStore,
  documentId?: string,
  ledger?: SealLedger | null,
  lookup?: SealTxLookup,
): Promise<number> {
  let done = 0;
  for (const saved of store.list()) {
    let p = saved;
    if (documentId && p.documentId !== documentId) continue;
    // Still being paid in this app (a page left mid-payment): its own flow settles it.
    if (p.fieldIds && inFlight.has(sealKey(p.identityKey ?? '', p.documentId, p.fieldIds))) continue;
    try {
      if (!p.beefHex) {
        const r = await lookUpUnsure(store, p, lookup);
        if (r === 'not_found') await releaseUnpaid(api, store, p);
        if (r !== 'found') continue;
        p = store.list().find((x) => x.nonce === saved.nonce) ?? p;
        if (!p.beefHex) continue;
      }
      const r = await api('recover', { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex });
      // In progress (429 / commit_in_progress), network or server fault: keep it for the next open or the sweep.
      if (keepsPayment(r)) continue;
      // Success (idempotent too), an orphaned result, or a definitive refusal: done with it.
      store.remove(p.nonce);
      const key = sealKey(p.identityKey ?? '', p.documentId, p.fieldIds ?? []);
      // Recorded (or sealed first by another party): sealed either way, never offered again from here.
      if (r.ok) {
        markSealed(ledger, key);
        forgetDrawing(store, key);
      }
      if (r.ok && !isOrphaned(r.body)) done++;
    } catch {
      /* next time */
    }
  }
  return done;
}

/** The on-screen check after an unclear payment: waits before each look (≈28 s in all, growing). */
export const SETTLE_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const;
/** "Not built" counts only when the wallet says so this many times in a row, seconds apart. */
export const SETTLE_NOT_FOUND_TIMES = 2;
export const CHECKING_PAYMENT_LINE = 'Checking whether the payment went out…';

export type SettleResult =
  /** Found in the wallet and recorded by /recover: one payment, signature recorded. */
  | { k: 'recorded'; out: NativeSealOutcome }
  /** The wallet never built it: the nonce is cancelled and the drawing kept (Try again, no redraw). */
  | { k: 'not_paid'; drawing: SealDrawing | null }
  /** Still unknown: held on this phone, finished by recovery on the next open. Never sign again. */
  | { k: 'unknown' }
  /** Found and paid, but bit-sign refused it for good, or another party sealed first. Nothing to retry. */
  | { k: 'failed'; code: 'failed' | 'orphaned'; message: string };

/**
 * Resolve an unclear seal payment ON THE SAME SCREEN instead of leaving the person at "failed" (owner, 23 Nov 2026):
 * looks for its transaction in this wallet's own storage a few times over about half a minute (bounded, with backoff).
 * Found → /recover with its BEEF (no second payment). Proved never built (SETTLE_NOT_FOUND_TIMES answers in a row, not
 * merely a failed lookup) → released as unpaid, drawing kept. Otherwise it stays held. Never pays, never throws.
 */
export async function settleUnsureSeal(o: {
  api: SealApi;
  store: PendingSealStore;
  nonce: string;
  lookup?: SealTxLookup;
  ledger?: SealLedger | null;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
  now?: () => number;
}): Promise<SettleResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let notFound = 0;
  for (const wait of o.delaysMs ?? SETTLE_DELAYS_MS) {
    await sleep(wait);
    try {
      let p = o.store.list().find((x) => x.nonce === o.nonce);
      // Gone: another page's recovery took it. What it did is not known here; the card shows the real state on open.
      if (!p) return { k: 'unknown' };
      const key = sealKey(p.identityKey ?? '', p.documentId, p.fieldIds ?? []);
      // Never while this seal is paying again in this app.
      if (p.fieldIds && inFlight.has(key)) return { k: 'unknown' };
      if (!p.beefHex) {
        const r = await lookUpUnsure(o.store, p, o.lookup);
        if (r === 'not_found') {
          if (++notFound < SETTLE_NOT_FOUND_TIMES) continue;
          return { k: 'not_paid', drawing: await releaseUnpaid(o.api, o.store, p, o.now) };
        }
        notFound = 0;
        if (r !== 'found') continue;
        p = o.store.list().find((x) => x.nonce === o.nonce);
        if (!p?.beefHex) continue;
      }
      const body = { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex };
      const r = await o.api('recover', body).catch(() => null);
      if (!r || keepsPayment(r)) continue; // in progress, network or server fault: look again
      o.store.remove(p.nonce);
      if (r.ok) {
        markSealed(o.ledger, key);
        forgetDrawing(o.store, key);
        if (isOrphaned(r.body))
          return {
            k: 'failed',
            code: 'orphaned',
            message:
              typeof r.body.message === 'string' && r.body.message
                ? r.body.message
                : 'Another party sealed this document first. Your payment is recorded; nothing more to do.',
          };
        const feeSats = feeFromAtomicBeef(Utils.toArray(p.beefHex, 'hex'));
        return {
          k: 'recorded',
          out: {
            signatureId: String(r.body.signatureId ?? ''),
            txid: String(r.body.txid || p.txid),
            docHash: String(r.body.docHash ?? ''),
            complete: !!r.body.complete,
            sealed: !!r.body.sealed,
            recovered: true,
            ...(feeSats != null ? { feeSats } : {}),
          },
        };
      }
      return {
        k: 'failed',
        code: 'failed',
        message: typeof r.body.error === 'string' && r.body.error ? r.body.error : 'The seal could not be recorded.',
      };
    } catch {
      /* look again */
    }
  }
  return { k: 'unknown' };
}

// ── The drawn signature, in exactly the web pad's format (bit-sign InPlaceSignaturePad / SovereignSignature) ──────────

/** POST to bChatX as the wallet's session; throws on a refusal. */
export type RoomPost = (path: string, body: Record<string, unknown>) => Promise<unknown>;

/**
 * The ROOM's steps after a native seal, exactly as the web room does them (bit-sign room page runPhoneRoomSteps):
 * fully signed → pin the sealed copy (POST /api/bitsign/rooms, which posts the "signed and sealed" row) and clear the
 * pending pointer (prepare-doc 'sealed'); part-signed → hand the signed copy on (prepare-doc 'send'). Without these the
 * room kept showing "Ready to sign" after the phone sealed (owner's iPhone, 3 Nov 2026). The seal is already on chain,
 * so a failure here is the room step only and is safe to retry.
 */
export async function nativeRoomSteps(
  post: RoomPost,
  ticker: string,
  manifest: Record<string, unknown> | null,
  out: Pick<NativeSealOutcome, 'signatureId' | 'txid' | 'docHash' | 'complete'>,
): Promise<'pinned' | 'handed-on'> {
  const room = `/api/bitsign/rooms/${encodeURIComponent(ticker)}/prepare-doc`;
  if (out.complete) {
    await post('/api/bitsign/rooms', {
      ticker,
      documentId: out.signatureId,
      docTxid: out.txid,
      docHash: out.docHash,
      manifest,
    });
    await post(room, { action: 'sealed' });
    return 'pinned';
  }
  await post(room, { action: 'send', documentId: out.signatureId });
  return 'handed-on';
}

/**
 * The signed copy after a native seal, for the phone to show (owner, 3 Nov 2026: "the document, once signed, did not
 * have the signature on it on my phone"). Same source as the room card: GET /api/bitsign/rooms/<T>/executed, tried by
 * each id in order (the original document, then the new signature). Null when none answers with HTML.
 */
export async function fetchSignedCopy(
  get: (path: string) => Promise<unknown>,
  ticker: string,
  ids: string[],
): Promise<string | null> {
  for (const id of ids.filter(Boolean)) {
    try {
      const html = await get(
        `/api/bitsign/rooms/${encodeURIComponent(ticker)}/executed?documentId=${encodeURIComponent(id)}`,
      );
      if (typeof html === 'string' && /<[a-z!]/i.test(html)) return html;
    } catch {
      /* try the next id */
    }
  }
  return null;
}

export type PadPoint = { x: number; y: number; pressure: number };

/** Strokes on a pad of `width`×`height` → the canonical SVG bit-sign's sanitiser accepts byte-for-byte. Null if empty. */
export function strokesToSvg(strokes: PadPoint[][], width: number, height: number): string | null {
  const usable = strokes.filter((s) => s.length > 1);
  if (!usable.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of usable)
    for (const p of s) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const pad = 20;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width, maxX + pad);
  maxY = Math.min(height, maxY + pad);
  const svgW = maxX - minX;
  const svgH = maxY - minY;
  let paths = '';
  for (const s of usable) {
    let d = `M ${(s[0].x - minX).toFixed(1)} ${(s[0].y - minY).toFixed(1)}`;
    for (let i = 1; i < s.length; i++) d += ` L ${(s[i].x - minX).toFixed(1)} ${(s[i].y - minY).toFixed(1)}`;
    const avg = s.reduce((n, p) => n + p.pressure, 0) / s.length;
    paths += `<path d="${d}" stroke="black" stroke-width="${(1 + avg * 4).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW.toFixed(0)} ${svgH.toFixed(0)}" width="${svgW.toFixed(0)}" height="${svgH.toFixed(0)}">${paths}</svg>`;
}

// ── Which blocks this person signs ─────────────────────────────────────────────────────────────────────────────────

export interface SigField {
  id: string;
  signerHandle?: string | null;
  role?: string;
  name?: string | null;
  required?: boolean;
}

/** The unsigned blocks bound to one of this person's handles (all handles of the same identity key). */
/**
 * Every handle the signed-in account holds, from GET /api/bitsign/me/handles ({ handles: [{ handle }], primary }).
 * A block bound to any of them is yours (owner, 3 Nov 2026: the Massey s561 block is bound to $boase while the phone
 * signs in as $b0asex, the same account, and the phone said "no signature block"). Bad or empty input → [].
 */
export function accountHandles(resp: unknown): string[] {
  const r = (resp ?? {}) as { handles?: Array<{ handle?: unknown }>; primary?: unknown };
  const out = new Set<string>();
  for (const h of Array.isArray(r.handles) ? r.handles : [])
    if (typeof h?.handle === 'string' && h.handle) out.add(h.handle);
  if (typeof r.primary === 'string' && r.primary) out.add(r.primary);
  return [...out];
}

/**
 * The account's names carried in a failed names-list response, for the seal page. Only a server error (5xx: the
 * P0 case, a 503 with fee_unavailable that still lists the names) is trusted to carry them; any other failure
 * (401, 403, 404, 4xx) gives none, so the page signs in again on a 401 or shows the error (review S7).
 */
export function handlesFromErrorBody(e: { status?: unknown; data?: unknown } | null | undefined): string[] {
  const status = e?.status;
  if (typeof status !== 'number' || status < 500 || status > 599) return [];
  return accountHandles(e?.data);
}

/**
 * Why the account's other names could not be loaded, for the seal page (never swallowed: a block bound to another of
 * your names would otherwise just look missing).
 */
export function namesLoadError(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  const code = typeof status === 'number' && status > 0 ? ` (${status})` : '';
  return `Couldn't load your other names${code}, so blocks for them can't be shown here. Try again in a moment.`;
}

export function myFields(fields: SigField[], myHandles: string[], signedIds: Set<string>): SigField[] {
  const mine = new Set(myHandles.map((h) => h.replace(/^\$/, '').toLowerCase()).filter(Boolean));
  return fields.filter(
    (f) =>
      !signedIds.has(f.id) && !!f.signerHandle && mine.has(String(f.signerHandle).replace(/^\$/, '').toLowerCase()),
  );
}

/** Blocks the document already shows signed (data-sig-anchor="x" data-signed="true"). */
export function signedFieldIds(html: string): Set<string> {
  const out = new Set<string>();
  const re = /<[a-zA-Z][a-zA-Z0-9-]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const a = m[1] || '';
    const id = /\sdata-sig-anchor\s*=\s*["']([^"']+)["']/i.exec(a)?.[1];
    if (id && /\sdata-signed\s*=\s*["']true["']/i.test(a)) out.add(id);
  }
  return out;
}

/** The document for display: scripts, event handlers and active URLs removed (it renders in a no-script frame too). */
export function inertHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '$1="#"');
}

/**
 * The native Review & sign screen for one room document (MobileRoutes "seal/:ticker/:doc"). Null for a bad ref, and
 * always null in a store build (storeBuild.ts NATIVE_SEAL_ENABLED: the screen isn't there; callers open bChatX's page).
 */
export const nativeSealRoute = (ticker: string, docId: string): string | null => {
  if (!NATIVE_SEAL_ENABLED) return null;
  const t = (ticker || '').trim().replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9_.-]{1,64}$/.test(t) || !/^[A-Za-z0-9-]{1,64}$/.test(docId || '')) return null;
  return `/m/seal/${encodeURIComponent(t)}/${encodeURIComponent(docId)}`;
};
