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
  /**
   * The release rule's evidence (unpaidProven, review of #560 M1): how many times the wallet answered "no such action",
   * spaced RELEASE_SPACING_MS apart, and when the first and last of those answers came.
   */
  notFound?: number;
  notFoundFirstAt?: number;
  notFoundLastAt?: number;
  /**
   * Paid on a kept (resumed) session (review of #560 M2): its output script is the earlier attempt's, so the lookup
   * searches from savedAt exactly (no back-off window) and skips the earlier attempts' txids.
   */
  resumed?: boolean;
  excludeTxids?: string[];
  /** A context is settling this record on screen right now (settleUnsureSeal): recovery elsewhere leaves it alone. */
  settling?: { by: string; until: number };
}

/**
 * Finds an unsure seal's transaction in this wallet's own storage (the page wires listActions + the services' BEEF).
 * `find`: the action whose outputs include the seal's script; { found: false } only when the wallet answered and has
 * no such action (then none was ever built: the toolbox stores an action before it signs or broadcasts it); null
 * when it could not tell. `beef`: the AtomicBEEF for a txid, null when it can't be had yet.
 */
export interface SealTxLookup {
  /**
   * `sinceMs`: when the record was saved; the search starts a minute before it, or exactly at it with `exact`.
   * `exclude`: txids that are not this attempt's (an earlier attempt of a resumed seal).
   */
  find(
    lockingScriptHex: string,
    sinceMs: number,
    opts?: { exact?: boolean; exclude?: readonly string[] },
  ): Promise<{ found: false } | { found: true; txid: string } | null>;
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
  opts: { exact?: boolean; exclude?: readonly string[] } = {},
): Promise<{ found: false } | { found: true; txid: string } | null> {
  const want = lockingScriptHex.toLowerCase();
  const skip = new Set((opts.exclude ?? []).map((t) => t.toLowerCase()));
  const from = `action time from ${Math.max(0, Math.floor(sinceMs - (opts.exact ? 0 : 60_000)))}`;
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
        const hit = r.actions.find(
          (a) =>
            !skip.has(String(a.txid).toLowerCase()) && a.outputs?.some((o) => o.lockingScript?.toLowerCase() === want),
        );
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
  /**
   * Pay-only retries running now in ANY context sharing this store (an extension popup and a tab share localStorage;
   * review of #560 M3). A kept session has no compose step, so bit-sign's composeHold can't stop a second context.
   */
  claims?: SealClaimStore;
}

/** "This context is paying this kept seal": who, and until when (then it is stale and ignored). */
export interface SealClaim {
  key: string;
  by: string;
  at: number;
  until: number;
}
export interface SealClaimStore {
  get(key: string): SealClaim | null;
  save(c: SealClaim): void;
  /** Removes it only when `by` still owns it. */
  remove(key: string, by: string): void;
}

/** This JS context (page, popup, tab): owner of claims and settling marks. Random, never stored beyond them. */
export const CONTEXT_ID: string = (() => {
  const b = new Uint8Array(8);
  try {
    globalThis.crypto.getRandomValues(b);
  } catch {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
})();
/** A claim lasts at most bit-sign's session (approval + payment fit well inside). */
export const SEAL_CLAIM_MS = 10 * 60_000;
/** Shown in a second window that finds the kept seal being paid in another. Nothing was signed or paid here. */
export const ELSEWHERE_MESSAGE = 'Already being sealed in another window. Nothing was paid here.';

const liveClaim = (store: PendingSealStore, key: string, now: number): SealClaim | null => {
  try {
    const c = store.claims?.get(key) ?? null;
    return c && c.until > now ? c : null;
  } catch {
    return null;
  }
};
/**
 * Is the claim on this kept seal still this context's? True too when the store keeps no claims, or can't be read
 * (blocked storage: then no other context can be using it either, and this context's in-flight hold remains).
 */
const claimIsMine = (store: PendingSealStore, key: string, now: number): boolean => {
  if (!store.claims) return true;
  let c: SealClaim | null;
  try {
    c = store.claims.get(key);
  } catch {
    return true;
  }
  return !!c && c.until > now && c.by === CONTEXT_ID;
};
const dropClaim = (store: PendingSealStore, key: string) => {
  try {
    store.claims?.remove(key, CONTEXT_ID);
  } catch {
    /* storage blocked: the claim times out */
  }
};
/** A record for this seal in the SHARED store (another context's unsure or paid record), whatever this context holds. */
const storeHasSeal = (store: PendingSealStore, key: string): boolean => {
  try {
    return store
      .list()
      .some((p) => p.fieldIds !== undefined && sealKey(p.identityKey ?? '', p.documentId, p.fieldIds) === key);
  } catch {
    return false;
  }
};

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
  /** Txids of earlier attempts on this session, if any were named: never this attempt's (review of #560 M2). */
  failedTxids?: string[];
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

// ── ONE release rule for an unsure record (review of #560 M1) ───────────────────────────────────────────────────────
/** "No such action" must be answered at least this many times… */
export const RELEASE_NOT_FOUND_TIMES = 2;
/** …each at least this long after the last one counted… */
export const RELEASE_SPACING_MS = 5_000;
/** …and the record must be at least this old (a remote storage commit or a failover can lag behind the payment). */
export const RELEASE_MIN_AGE_MS = 3 * 60_000;
/** A held record with no transaction this long after it was saved: the page says "Contact support" (never cancels). */
export const HELD_SUPPORT_AFTER_MS = 24 * 60 * 60_000;

/** Pure: has the wallet proved, by the one rule, that this unsure record's payment was never built? */
export const unpaidProven = (p: PendingSeal, now: number): boolean =>
  !p.beefHex &&
  !p.txid &&
  (p.notFound ?? 0) >= RELEASE_NOT_FOUND_TIMES &&
  (p.notFoundLastAt ?? 0) - (p.notFoundFirstAt ?? 0) >= RELEASE_SPACING_MS * (RELEASE_NOT_FOUND_TIMES - 1) &&
  now - p.savedAt >= RELEASE_MIN_AGE_MS;

/** Pure: one more "no such action" answer, counted only when RELEASE_SPACING_MS after the last one counted. */
export const withNotFound = (p: PendingSeal, now: number): PendingSeal => {
  const n = p.notFound ?? 0;
  if (!n || p.notFoundFirstAt === undefined || p.notFoundLastAt === undefined)
    return { ...p, notFound: 1, notFoundFirstAt: now, notFoundLastAt: now };
  if (now - p.notFoundLastAt < RELEASE_SPACING_MS) return p;
  return { ...p, notFound: n + 1, notFoundLastAt: now };
};

/** A record being settled on screen by a live context (its mark not yet stale). */
export const beingSettled = (p: PendingSeal, now: number): boolean => !!p.settling && p.settling.until > now;

/**
 * A held seal of this signer, document and blocks still not recorded HELD_SUPPORT_AFTER_MS after it was saved (no
 * transaction found, or bit-sign refused its payment), if any: the page says "Contact support"; nothing is cancelled.
 */
export const heldTooLong = (
  store: PendingSealStore,
  identityKey: string,
  documentId: string,
  fieldIds: readonly string[],
  now: number,
): PendingSeal | null => {
  const key = sealKey(identityKey, documentId, fieldIds);
  try {
    return (
      store
        .list()
        .find(
          (p) =>
            p.documentId === documentId &&
            now - p.savedAt > HELD_SUPPORT_AFTER_MS &&
            (p.fieldIds === undefined || sealKey(p.identityKey ?? '', p.documentId, p.fieldIds) === key),
        ) ?? null
    );
  } catch {
    return null;
  }
};
/** The words for a held seal past HELD_SUPPORT_AFTER_MS: a reference support can find; nothing is cancelled. */
export const heldSupportMessage = (p: Pick<PendingSeal, 'nonce'>): string =>
  `This seal still isn't confirmed after a day. Contact support with reference seal-${p.nonce.slice(0, 12)}. Don't sign it again: no money is cancelled.`;

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
  /** The seal's session: reports are sent once per nonce and error kind (sealReport.ts). Never shown or reported. */
  nonce?: string;
}

const tellFailure = (input: { onFailure?: (f: SealFailure) => void }, f: SealFailure) => {
  try {
    input.onFailure?.(f);
  } catch {
    /* a report never changes the seal */
  }
};

/** The words for a createAction that proved nothing went out: the wallet's own, always saying nothing was paid. */
export const notPaidText = (e: unknown): string => {
  const info = classifySendError(e, 'send');
  if (info.kind === 'cancelled') return 'You cancelled the payment. Nothing was paid.';
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (!raw) return REFUSED_NOT_PAID_MESSAGE;
  // One "Nothing was paid." (review of #560 L5): the wallet's own "Nothing was sent." becomes it, never both.
  const said = raw.replace(/\bnothing (?:was|has been) (?:sent|paid)\b\.?/gi, 'Nothing was paid.');
  return /nothing was paid/i.test(said) ? said : `${said.replace(/\s*$/, '')} Nothing was paid.`;
};

/**
 * createAction refusals that happen before ANYTHING is built (review of #560 M2): only these keep the session for a
 * pay-only retry. A refusal after building (spent elsewhere, a refused broadcast…) may have left an action with the
 * same output script in the wallet, so its retry prepares a new session (new nonce, new script) from the same drawing.
 */
const PRE_BUILD_KINDS = new Set<SendErrorKind>([
  'locked',
  'worker-restarted',
  'device-not-active',
  'insufficient-funds',
]);
const isUsbRefusal = (e: unknown) =>
  e instanceof Error && (e.name === 'UsbKeyAbsentError' || /^Insert your USB key to continue$/.test(e.message));
export const refusedBeforeBuild = (e: unknown): boolean =>
  provablyNotPaid(e) && (isUsbRefusal(e) || PRE_BUILD_KINDS.has(classifySendError(e, 'send').kind));
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
  if (isUsbRefusal(e)) return true;
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
      | 'orphaned'
      /** A kept seal is being paid in another window (review of #560 M3): nothing here, never retried from here. */
      | 'elsewhere',
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
/**
 * After payment, is bit-sign's answer FINAL for the saved payment (#561 review B)? Only "recorded" (2xx, orphaned
 * included) or "this session was already committed" (409 replayed). Everything else keeps the paid record: a network or
 * server fault, in progress, 401 / 403 (a stale or rotated bChatX session), 404 (not_yours: asked as the wrong
 * account) and any other refusal. Money is never forgotten on an answer that could change.
 */
const finalForPayment = (r: Pick<SealApiReply, 'ok' | 'status' | 'body'>): boolean =>
  r.ok || (r.status === 409 && r.body.code === 'replayed');
/** Keep it, and ask again later, without calling it refused: faults, in progress, and the answers of a wrong session. */
const keepsPayment = (r: Pick<SealApiReply, 'status' | 'body'>): boolean =>
  r.status === 0 || r.status >= 500 || isInProgress(r) || r.status === 401 || r.status === 403 || r.status === 404;
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
export const SEAL_SPENT_MESSAGE = 'A coin was already spent on another device. Nothing was paid. Tap Try again.';

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
    // A pay-only retry's claim (review of #560 M3) ends with it: its unsure or paid record now speaks for it.
    dropClaim(input.store, key);
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
  resumed?: SealResume | null,
) {
  try {
    // The same record saved again (with a txid learnt): it keeps its first time, which the lookup and the release
    // rule both measure from.
    const before = input.store.list().find((x) => x.nonce === nonce);
    input.store.save({
      documentId: input.documentId,
      nonce,
      txid,
      beefHex: '',
      attestation,
      savedAt: before?.savedAt ?? (input.now ?? Date.now)(),
      ...(resumed ? { resumed: true, excludeTxids: [...(resumed.failedTxids ?? [])] } : {}),
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

/** Thrown inside afterPrepare when a kept session ran out during the approval (L1): prepare afresh, no second sheet. */
class SessionRanOut extends Error {}

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
  if (reuse) {
    // ⚠ TWO WINDOWS, ONE KEPT SEAL (review of #560 M3): there is no compose step to hold the session, so a claim in the
    // shared store says who is paying it. Another live claim → this window stops, nothing signed or paid here.
    const c = liveClaim(input.store, key, now());
    if (c && c.by !== CONTEXT_ID) throw new NativeSealError(ELSEWHERE_MESSAGE, 'elsewhere');
    try {
      input.store.claims?.save({ key, by: CONTEXT_ID, at: now(), until: now() + SEAL_CLAIM_MS });
    } catch {
      /* storage blocked: this context's in-flight hold remains */
    }
  }
  /** Approved already in this call (a kept session that ran out during its approval): never a second sheet. */
  let approved = false;
  for (;;) {
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
      return await afterPrepare(input, hold, key, prepared, expiresAt, reuse, approved, () => (mayHavePaid = true));
    } catch (e) {
      if (e instanceof SessionRanOut) {
        // L1: the kept session ended while the sheet was up. Give it back and prepare a new one from the same drawing,
        // without asking again: the approval was for this very seal of this document, at this fee.
        await cancelSeal(input.api, prepared.nonce, input.clock);
        dropClaim(input.store, key);
        reuse = null;
        approved = true;
        continue;
      }
      // Nothing can have been paid (before the payment, or a refusal that proves it): free the nonce, unless the
      // failure kept this seal for a pay-only retry (its drawing carries the resume), or another window is paying it.
      const keptForRetry = e instanceof NativeSealError && (!!e.drawing?.resume || e.code === 'elsewhere');
      if (!mayHavePaid && !keptForRetry) await cancelSeal(input.api, prepared.nonce, input.clock);
      throw e;
    }
  }
}

async function afterPrepare(
  input: Parameters<typeof nativeSignAndSeal>[0],
  hold: Hold,
  key: string,
  prepared: PreparedSeal,
  expiresAt: number,
  reuse: SealResume | null,
  preApproved: boolean,
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
  // EVERY payment, a retry too: the sheet, then Face ID / passcode or the wallet password (sealApproval.ts). The one
  // exception is a kept session that ran out during THIS call's approval (SessionRanOut): approved once is enough.
  if (!preApproved) step('approving');
  const answer = preApproved ? true : await input.approve(prepared, shownFee);
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
  // L1: the sheet can sit open for minutes. A kept session that ran out meanwhile is never paid on.
  if (reuse && !(now() < reuse.expiresAt - RESUME_MARGIN_MS)) throw new SessionRanOut();

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
  const resume: SealResume = {
    key,
    svg,
    prepared,
    composed,
    attestation,
    expiresAt,
    ...(reuse?.failedTxids?.length ? { failedTxids: [...reuse.failedTxids] } : {}),
  };

  // Left (abandonSeal) or held too long: stop here, before any money moves. From here the hold stays until settled.
  if (hold.abandoned)
    throw new NativeSealError(hold.abandoned === 'left' ? LEFT_PAGE_MESSAGE : EXPIRED_HOLD_MESSAGE, 'cancelled');
  // ⚠ M3, right before any money moves: still this window's claim, and no other window's record for this seal.
  if (reuse && (!claimIsMine(input.store, key, now()) || storeHasSeal(input.store, key)))
    throw new NativeSealError(ELSEWHERE_MESSAGE, 'elsewhere');
  // ⚠ BEFORE ANY MONEY MOVES: an unsure record, so nothing that happens next can leave this seal unaccounted for.
  saveUnsure(input, prepared.nonce, attestation, lockingScriptHex, '', reuse);
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
      // Refused before anything went out: nothing paid, the unsure record goes. Refused before anything was BUILT
      // (refusedBeforeBuild): the nonce, the composed record and the attestation are KEPT so Try again only approves
      // and pays. Any other refusal (review of #560 M2): the drawing only; the nonce is cancelled and Try again
      // prepares a new session, so its output script can never be confused with this attempt's.
      input.store.remove(prepared.nonce);
      const kept = keepDrawing(input.store, refusedBeforeBuild(e) ? drawing(resume) : drawing());
      tellFailure(input, { outcome: 'not_paid', step: 'paying', error: e, nonce: prepared.nonce });
      if (isSpentCoinError(e)) throw new NativeSealError(SEAL_SPENT_MESSAGE, 'spent_elsewhere', 0, { drawing: kept });
      throw new NativeSealError(notPaidText(e), 'not_paid', 0, { drawing: kept });
    }
    // ⚠ ANY DOUBT: it may have gone out. Never cancel the nonce, never offer a retry; this seal is held on this phone
    // (with the drawing) until its transaction is found in the wallet's own storage, or proved never built.
    paymentMayHaveGoneOut();
    if (txidIn(e)) saveUnsure(input, prepared.nonce, attestation, lockingScriptHex, txidIn(e), reuse);
    tellFailure(input, { outcome: 'pending_recovery', step: 'paying', error: e, nonce: prepared.nonce });
    throw new NativeSealError(MAY_HAVE_PAID_MESSAGE, 'pending_recovery', 0, { nonce: prepared.nonce });
  }
  if (!paid?.txid || !paid.tx) {
    // A txid with no transaction (or neither): it may well have gone out. The unsure record stays (with the txid).
    paymentMayHaveGoneOut();
    const t = typeof paid?.txid === 'string' && /^[0-9a-f]{64}$/i.test(paid.txid) ? paid.txid.toLowerCase() : '';
    if (t) saveUnsure(input, prepared.nonce, attestation, lockingScriptHex, t, reuse);
    tellFailure(input, {
      outcome: 'pending_recovery',
      step: 'paying',
      nonce: prepared.nonce,
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
        break; // network / server fault, or a session that can change: kept for the next open
      } else {
        // A refusal. Only "already committed" (replayed) lets the paid record go; any other is kept for support.
        if (finalForPayment(r)) input.store.remove(prepared.nonce);
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
      nonce: prepared.nonce,
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
 * An unsure record proved unpaid by the ONE rule (unpaidProven): the record goes, the nonce is cancelled (bit-sign
 * never composes a cancelled nonce again, but still records a paid BEEF for it, so a late find is not lost on the
 * server) and the drawing is kept for "Seal again". Returns that drawing, if any.
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
 * 'not_found': the wallet answered "no such action"; the answer is counted ON the record (withNotFound), and the record
 * is released only when unpaidProven says so. 'unknown': no lookup, no script, the lookup failed, or the BEEF is not to
 * be had yet; held (a txid learnt is kept). A record paid on a kept session is searched from its own time exactly,
 * skipping earlier attempts' txids (review of #560 M2).
 */
async function lookUpUnsure(
  store: PendingSealStore,
  p: PendingSeal,
  lookup: SealTxLookup | undefined,
  now: () => number,
): Promise<'found' | 'not_found' | 'unknown'> {
  if (!lookup) return 'unknown';
  let txid = p.txid;
  if (!txid) {
    if (!p.lockingScriptHex) return 'unknown';
    const f = await lookup
      .find(p.lockingScriptHex, p.savedAt, p.resumed ? { exact: true, exclude: p.excludeTxids ?? [] } : undefined)
      .catch(() => null);
    if (!f) return 'unknown';
    if (!f.found) {
      store.save(withNotFound(p, now()));
      return 'not_found';
    }
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

/** What recovery did with one saved record (so a caller can say the true thing). */
export type RecoverOutcome =
  /** bit-sign recorded it (orphaned: another party sealed first; the payment is recorded against the session). */
  | 'recorded'
  /** Proven never built (unpaidProven): released, nonce cancelled, drawing kept. */
  | 'released'
  /** Still held: unknown, in flight, being settled, a fault, or an answer that can change (401 / 403 / 404). */
  | 'kept'
  /** bit-sign refused it with an answer that won't change on its own. Kept on the phone (never forgotten): support. */
  | 'refused';
export interface RecoverResult {
  nonce: string;
  documentId: string;
  outcome: RecoverOutcome;
  orphaned?: true;
}
/** How many records recovery recorded (orphaned ones not counted). */
export const recordedCount = (rs: readonly RecoverResult[]): number =>
  rs.filter((r) => r.outcome === 'recorded' && !r.orphaned).length;

/**
 * Finish seals saved on this phone for THIS account (#561 review A): records saved by another identity key are never
 * touched (their recovery would ask bit-sign as the wrong account, or search the wrong wallet). Records with no
 * identity key (saved before 6 Nov 2026) are recovered only with `keyless` for one document, from the seal page opened
 * under the right account; never in bulk. Paid-but-unrecorded ones go through /recover; unsure ones through the
 * wallet's own storage first (lookUpUnsure) and are released only by unpaidProven. A seal running or being settled
 * right now is left alone. Never throws.
 */
export async function recoverNativeSeals(
  api: SealApi,
  store: PendingSealStore,
  documentId: string | undefined,
  ledger: SealLedger | null | undefined,
  lookup: SealTxLookup | undefined,
  opts: { identityKey: string; keyless?: boolean; now?: () => number },
): Promise<RecoverResult[]> {
  const now = opts.now ?? Date.now;
  const me = (opts.identityKey || '').toLowerCase();
  const out: RecoverResult[] = [];
  let saved: PendingSeal[] = [];
  try {
    saved = store.list();
  } catch {
    return out;
  }
  for (const s0 of saved) {
    let p = s0;
    if (documentId && p.documentId !== documentId) continue;
    if (p.identityKey === undefined || p.identityKey === '') {
      if (!(opts.keyless && documentId)) continue;
    } else if (!me || p.identityKey.toLowerCase() !== me) continue;
    const result = (outcome: RecoverOutcome, orphaned = false) =>
      out.push({ nonce: p.nonce, documentId: p.documentId, outcome, ...(orphaned ? { orphaned: true as const } : {}) });
    // Still being paid in this app (a page left mid-payment), or settled on screen by a live context: theirs.
    if (p.fieldIds && inFlight.has(sealKey(p.identityKey ?? '', p.documentId, p.fieldIds))) {
      result('kept');
      continue;
    }
    if (beingSettled(p, now())) {
      result('kept');
      continue;
    }
    try {
      if (!p.beefHex) {
        const r = await lookUpUnsure(store, p, lookup, now);
        p = store.list().find((x) => x.nonce === s0.nonce) ?? p;
        if (r === 'not_found' && unpaidProven(p, now())) {
          await releaseUnpaid(api, store, p, now);
          result('released');
          continue;
        }
        if (r !== 'found' || !p.beefHex) {
          result('kept');
          continue;
        }
      }
      const r = await api('recover', { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex });
      if (keepsPayment(r)) {
        result('kept');
        continue;
      }
      if (!finalForPayment(r)) {
        result('refused'); // kept on the phone: "Contact support" after HELD_SUPPORT_AFTER_MS
        continue;
      }
      store.remove(p.nonce);
      const key = sealKey(p.identityKey ?? '', p.documentId, p.fieldIds ?? []);
      // Recorded (or sealed first by another party, or committed already): never offered again from here.
      markSealed(ledger, key);
      forgetDrawing(store, key);
      result('recorded', r.ok ? isOrphaned(r.body) : true);
    } catch {
      result('kept');
    }
  }
  return out;
}

/** The on-screen check after an unclear payment: waits before each look, growing, then every SETTLE_LATER_MS. */
export const SETTLE_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const;
export const SETTLE_LATER_MS = 20_000;
/**
 * The check runs at most this long: long enough for the release rule (RELEASE_MIN_AGE_MS since the record was saved)
 * to decide on screen. Leaving the screen stops it; recovery on the next open applies the same rule.
 */
export const SETTLE_MAX_MS = 4 * 60_000;
/** A settling mark lasts this long unless refreshed (each look refreshes it). */
export const SETTLE_MARK_MS = 60_000;
export const CHECKING_PAYMENT_LINE = 'Checking whether the payment went out…';
/** Under the line: why it can take a while, and that leaving is safe. */
export const CHECKING_PAYMENT_NOTE =
  "This can take up to 3 minutes. You can leave this screen: it's finished when you open it again.";

/** The schedule of waits: SETTLE_DELAYS_MS, then SETTLE_LATER_MS until about SETTLE_MAX_MS. */
export const settleSchedule = (): number[] => {
  const out: number[] = [...SETTLE_DELAYS_MS];
  let total = out.reduce((a, b) => a + b, 0);
  while (total + SETTLE_LATER_MS <= SETTLE_MAX_MS) {
    out.push(SETTLE_LATER_MS);
    total += SETTLE_LATER_MS;
  }
  return out;
};

export type SettleResult =
  /** Found in the wallet and recorded by /recover: one payment, signature recorded. */
  | { k: 'recorded'; out: NativeSealOutcome }
  /** Proven never built (unpaidProven): the nonce is cancelled and the drawing kept (Try again, no redraw). */
  | { k: 'not_paid'; drawing: SealDrawing | null }
  /** Still unknown (or the screen was left): held on this phone, finished by recovery on the next open. */
  | { k: 'unknown' }
  /** Found and paid, but bit-sign refused it with an answer that won't change, or another party sealed first. */
  | { k: 'failed'; code: 'failed' | 'orphaned'; message: string };

/**
 * Resolve an unclear seal payment ON THE SAME SCREEN instead of leaving the person at "failed" (owner, 23 Nov 2026).
 * Looks for its transaction in this wallet's own storage on settleSchedule() (bounded, with backoff), marking the
 * record as being settled so recovery in another page or window leaves it alone. Found → /recover with its BEEF (no
 * second payment). Released only by the ONE rule (unpaidProven: ≥2 "no such action" answers ≥5 s apart, and the record
 * ≥3 minutes old); until then the record is kept, so a late find still goes to /recover. `stopped()` (the page left)
 * ends it at the next step, keeping the record. Never pays, never throws.
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
  stopped?: () => boolean;
}): Promise<SettleResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const find = () => {
    try {
      return o.store.list().find((x) => x.nonce === o.nonce);
    } catch {
      return undefined;
    }
  };
  const mark = (until: number | null) => {
    const p = find();
    if (!p) return;
    try {
      if (until === null) {
        if (p.settling?.by === CONTEXT_ID) {
          const { settling: _gone, ...rest } = p;
          void _gone;
          o.store.save(rest);
        }
      } else o.store.save({ ...p, settling: { by: CONTEXT_ID, until } });
    } catch {
      /* storage blocked: recovery may run alongside; both only ever keep or record */
    }
  };
  try {
    for (const wait of o.delaysMs ?? settleSchedule()) {
      mark(now() + wait + SETTLE_MARK_MS);
      await sleep(wait);
      if (o.stopped?.()) return { k: 'unknown' };
      try {
        let p = find();
        // Gone: another page's recovery took it. What it did is not known here; the card shows the real state on open.
        if (!p) return { k: 'unknown' };
        const key = sealKey(p.identityKey ?? '', p.documentId, p.fieldIds ?? []);
        // Never while this seal is paying again in this app.
        if (p.fieldIds && inFlight.has(key)) return { k: 'unknown' };
        if (!p.beefHex) {
          const r = await lookUpUnsure(o.store, p, o.lookup, now);
          p = find();
          if (!p) return { k: 'unknown' };
          if (r === 'not_found') {
            if (!unpaidProven(p, now())) continue;
            return { k: 'not_paid', drawing: await releaseUnpaid(o.api, o.store, p, o.now) };
          }
          if (r !== 'found' || !p.beefHex) continue;
        }
        const body = { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex };
        const r = await o.api('recover', body).catch(() => null);
        if (!r || keepsPayment(r)) continue; // in progress, a fault, or a session that can change: look again
        if (!finalForPayment(r))
          return {
            k: 'failed',
            code: 'failed',
            message:
              typeof r.body.error === 'string' && r.body.error ? r.body.error : 'The seal could not be recorded.',
          };
        o.store.remove(p.nonce);
        markSealed(o.ledger, key);
        forgetDrawing(o.store, key);
        if (!r.ok || isOrphaned(r.body))
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
      } catch {
        /* look again */
      }
    }
    return { k: 'unknown' };
  } finally {
    mark(null);
  }
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
