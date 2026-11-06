import { Transaction } from '@bsv/sdk';
import { NATIVE_SEAL_ENABLED } from '../storeBuild';
import { SPENT_ELSEWHERE_SHORT_MESSAGE, SPENT_ELSEWHERE_STUCK_MESSAGE } from '../../utils/sendErrors';
import { browserWakeClock, waitForCoinCheck, type WakeClock } from './coinWait';
import { WALL_TIMEOUT, withinWallClock } from '../../services/wallClock';

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
  path: 'prepare' | 'compose' | 'receipt' | 'commit' | 'recover',
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
}
export interface PendingSealStore {
  list(): PendingSeal[];
  save(p: PendingSeal): void;
  remove(nonce: string): void;
}

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

export type SealHere = 'none' | 'in_flight' | 'recording' | 'sealed';

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
    if (
      store
        .list()
        .some(
          (p) =>
            p.documentId === documentId &&
            (p.identityKey === undefined ||
              p.fieldIds === undefined ||
              sealKey(p.identityKey, p.documentId, p.fieldIds) === key),
        )
    )
      return 'recording';
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
      | 'orphaned',
    readonly status = 0,
  ) {
    super(message);
    this.name = 'NativeSealError';
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

/**
 * Sign and seal. `approve(prepared)` is the ONE approval (the wallet's own sheet + Face ID), asked after prepare (so it
 * can show the fee and the reference) and before anything is signed or paid; false = cancelled, nothing happens.
 */
export async function nativeSignAndSeal(input: {
  documentId: string;
  fieldIds: string[];
  svg: string;
  api: SealApi;
  keys: SealKeys;
  store: PendingSealStore;
  /** Seals recorded from this device (sealKey): one listed here is never sealed again (the double-pay guard). */
  ledger?: SealLedger | null;
  /** The wallet's identity key: part of the seal's key (another account on this phone signs on its own). */
  identityKey?: string;
  approve: (prepared: PreparedSeal) => Promise<boolean>;
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
    if (!hold.paying) hold.abandoned = 'expired';
    release();
  });
  try {
    const out = await signAndSealOnce(input, hold);
    markSealed(input.ledger, key);
    return out;
  } catch (e) {
    // Another party sealed first: the document is sealed, so it is never offered again from here either.
    if (e instanceof NativeSealError && e.code === 'orphaned') markSealed(input.ledger, key);
    throw e;
  } finally {
    release();
    settle();
  }
}

async function signAndSealOnce(input: Parameters<typeof nativeSignAndSeal>[0], hold: Hold): Promise<NativeSealOutcome> {
  const step = (s: SealStep) => input.onStep?.(s);
  step('preparing');
  const prepared = (await call(input.api, 'prepare', {
    documentId: input.documentId,
    fieldIds: input.fieldIds,
  })) as unknown as PreparedSeal;

  step('approving');
  if (!(await input.approve(prepared)))
    throw new NativeSealError('Not sealed: you cancelled. Nothing was signed or paid.', 'cancelled');

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

  step('composing');
  const composed = await call(input.api, 'compose', { nonce: prepared.nonce, svg: input.svg.trim() });
  const signing = composed.signing as { protocolID: [0 | 1 | 2, string]; keyID: string; counterparty: string };
  const recordCanonical = String(composed.recordCanonical);
  const lockingScriptHex = String(composed.lockingScriptHex);

  step('signing');
  const { signature } = await input.keys.createSignature({
    protocolID: signing.protocolID,
    keyID: signing.keyID,
    counterparty: signing.counterparty,
    data: Array.from(new TextEncoder().encode(recordCanonical)),
  });
  const attestation = toHex(signature);

  // Left (abandonSeal) or held too long: stop here, before any money moves. From here the hold stays until settled.
  if (hold.abandoned)
    throw new NativeSealError(hold.abandoned === 'left' ? LEFT_PAGE_MESSAGE : EXPIRED_HOLD_MESSAGE, 'cancelled');
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
    // Refused, so nothing was paid and nothing is saved for recovery. The raw text stays in the console.
    if (isSpentCoinError(e)) {
      console.warn('[nativeSeal] pay refused: coin already spent', e instanceof Error ? e.message : e);
      throw new NativeSealError(SEAL_SPENT_MESSAGE, 'spent_elsewhere');
    }
    throw e;
  }
  if (!paid?.txid || !paid.tx)
    throw new NativeSealError('The wallet did not return the seal transaction, so nothing was recorded.', 'failed');
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

/** Finish paid-but-unrecorded seals saved on this phone (for this document, or all). Never throws. */
export async function recoverNativeSeals(
  api: SealApi,
  store: PendingSealStore,
  documentId?: string,
  ledger?: SealLedger | null,
): Promise<number> {
  let done = 0;
  for (const p of store.list()) {
    if (documentId && p.documentId !== documentId) continue;
    try {
      const r = await api('recover', { nonce: p.nonce, attestation: p.attestation, txid: p.txid, beefHex: p.beefHex });
      // In progress (429 / commit_in_progress), network or server fault: keep it for the next open or the sweep.
      if (keepsPayment(r)) continue;
      // Success (idempotent too), an orphaned result, or a definitive refusal: done with it.
      store.remove(p.nonce);
      // Recorded (or sealed first by another party): sealed either way, never offered again from here.
      if (r.ok) markSealed(ledger, sealKey(p.identityKey ?? '', p.documentId, p.fieldIds ?? []));
      if (r.ok && !isOrphaned(r.body)) done++;
    } catch {
      /* next time */
    }
  }
  return done;
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
