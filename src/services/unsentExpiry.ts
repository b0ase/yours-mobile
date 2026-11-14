/**
 * Deadlines for unbroadcast (noSend) payments, so the user's coins are never held forever (BRC-177, owner 26 Oct
 * 2026).
 *
 * A noSend transaction is signed and handed to someone else to broadcast (bit-sign for room messages, our server for
 * theme orders and names, a bMail recipient, a site's own chain). Until it is broadcast its inputs are reserved: the
 * wallet won't spend them, and its change only exists if the network gets the transaction. If nobody ever broadcasts
 * it, that money is stuck.
 *
 * BRC-177 bounds this with a deadline per action (label `p nosend expiry seconds|timestamp|blockheight <n>` or
 * `never`) and, at the deadline, a reclaim. Its full form prefunds a dedicated anchor output and pre-signs a reclaim
 * spending it; the toolbox we run does not do that (it refuses change outputs as explicit inputs), so this is the
 * closest safe equivalent, run from the wallet's own list of nosend actions:
 *
 *  1. Every nosend action gets a deadline: its BRC-177 label if it has a valid one, else DEFAULT_TTL_S (24 h) from
 *     the first time this wallet saw it. Whatever the label says (`never`, a far timestamp or block height, a long
 *     duration), no hold lasts longer than MAX_HOLD_S (14 days) from first sight (owner 26 Oct 2026: sites may not hold
 *     the user's coins forever). A blockheight label is checked against WhatsOnChain's height (wocHeight); if the
 *     height can't be read the action simply isn't due yet. Deadlines are persisted and never restart. Reaching a
 *     deadline only makes an action a candidate: step 2 decides.
 *  2. At the deadline, nothing is released unless the chain says, conclusively, that the original was not
 *     broadcast. The rules of services/unsentGuard.ts are kept and tightened:
 *       - the transaction is seen anywhere (WhatsOnChain or 1Sat) → hand it to the wallet's send path (sendWith), as
 *         settleWhenSeen does; never release;
 *       - any input is spent on chain (by the original or by anything else), its parent is unknown, or any answer is
 *         unclear → keep it, try again on the next run;
 *       - only when every input is cleanly unspent (WhatsOnChain's spent lookup, confirmed or mempool) AND the
 *         transaction is a clean 404 everywhere on every retry for ~30 s (chainSaysUnknown) AND the inputs are
 *         re-checked unspent right before, is the action aborted, which returns its inputs to the wallet.
 *     Inputs that came from another of our own expired noSend transactions count only when that one is released in
 *     the same run; children are released before their parents.
 *     One exception to "any input spent → keep" (13 Nov 2026, the owner's tx 446: a Store payment held on the
 *     extension for days after his phone spent one of its three coins): an input spent by a DIFFERENT transaction the
 *     chain has conclusively (WhatsOnChain calls the spend confirmed, or WhatsOnChain and the 1Sat spend index name
 *     the same spender: autoCoinResync's clearingSpender rule) means this payment can never be mined, unless the
 *     spender IS this payment, re-signed or malleated (it then paid the recipient: cancelling it would invite a
 *     second payment). So it is cancelled only when every other input is cleanly unspent, the spenders can all be
 *     read (spenderOutputs) and, together, they do NOT pay every one of this payment's own payment outputs (the
 *     outputs to others: its change, which a re-sign changes with the fee, and 0-sat OP_RETURN memos are left out of
 *     the comparison; nothing left to compare is kept), and the same ~30 s "missing everywhere" check passes. Then each
 *     such input is detached from the action (detachInput: unspendable, recorded for the coin check), and the abort
 *     and a re-mark of those coins as unspendable run under ONE exclusive storage lock (abortRemarking), because the
 *     toolbox's abort finds the inputs through the raw tx and frees them again: no coin selection can run in between.
 *     Where that isn't wired, the abort is followed by reaffirmSpent, retried. Detach and abort run only while this
 *     device's store is the active one and no storage switch is under way (storageGate, read again between them). A
 *     spend seen only in the mempool by one source keeps the hold, as before.
 *  1b. Store payments (13 Nov 2026): a nosend action the wallet's own record identifies as a Store payment (its
 *     description and memo output name the quote: storeKind). Only on the device that MADE the payment (its Store
 *     flow recorded the txid and quote id here: storeKind 'mine'; a site can't write that record) and only when the
 *     Store has never heard of the quote (storeAsk) is it due as soon as STORE_MIN_AGE_S has passed since first sight;
 *     it then goes through every check above, and the Store is asked again, inside the payment's lock, just before
 *     the abort. That device's own Pay takes the same lock, so a release and a send of it can't both happen.
 *     Every other device (the payment arrived by device sync: 'other-device') can't see that device's retry state
 *     (its outbox, an intent the Store never got) and may not race its "Pay again": it holds a Store payment for
 *     STORE_OTHER_DEVICE_TTL_S (3 days) instead of the 24 h default, releasing it at 24 h only when an input is
 *     conclusively spent elsewhere (it can then never be mined, whoever sends it). A Store that has heard of it, or
 *     gives no clear answer, leaves it on the normal deadline (an unclear answer is asked again next run). Runs at
 *     every unlock and on the background's timer. Follow-up (needs a server change): docs/BSTORE.md "Withdrawn txids".
 *  3. A released transaction can still be broadcast by whoever holds it, as long as the wallet has not spent its
 *     inputs yet (BRC-177 calls this the race at expiry). So each release is watched for WATCH_S (14 days): if the
 *     original shows up on chain, the wallet's own recovery (recoverByTxid: proof attached, outputs set spendable)
 *     is run for it, so its change is not lost.
 *
 * It builds, signs and broadcasts nothing itself. Every decision is logged as a [bwx-expiry] line.
 */
import { chainSaysUnknown, defaultLookups, type ChainLookup, type Sighting } from './unsentGuard';
import { clearingSpender, type WocAnswer } from './autoCoinResync';

/** Default deadline for a nosend action without a BRC-177 label: our servers broadcast in seconds; 24 h is ample. */
export const DEFAULT_TTL_S = 24 * 60 * 60;
/** How long a released transaction is watched in case its holder broadcasts it after all. */
export const WATCH_S = 14 * 24 * 60 * 60;
/**
 * The longest any nosend action is held, whatever its BRC-177 label (owner 26 Oct 2026). Reaching it releases nothing
 * by itself: the action still goes through every chain check below.
 */
export const MAX_HOLD_S = 14 * 24 * 60 * 60;
/** Runs at most this often unless forced. */
export const MIN_INTERVAL_MS = 10 * 60_000;
/**
 * A Store payment the Store has never heard of is due this long after first sight (1b). Runs are MIN_INTERVAL_MS apart
 * and first sight is the first run that lists it, so a Pay in progress (backup ≤ 60 s, intent ≤ 20 s) is long done.
 */
export const STORE_MIN_AGE_S = 10 * 60;
/**
 * The default deadline for a Store payment on a device that did not make it (1b): long enough for the paying device's
 * "Pay again" after a store_unreachable, whose intent this device can't see. Still capped by MAX_HOLD_S.
 */
export const STORE_OTHER_DEVICE_TTL_S = 3 * 24 * 60 * 60;

const TXID = /^[0-9a-f]{64}$/i;

// ── BRC-177 labels ──

export type ExpiryPolicy =
  | { mode: 'seconds'; value: number }
  | { mode: 'timestamp'; value: number }
  | { mode: 'blockheight'; value: number }
  | { mode: 'never' }
  | { mode: 'default' };

const LABEL = /^p nosend expiry (seconds|timestamp|blockheight) (0|[1-9][0-9]*)$/;

/**
 * The action's BRC-177 policy. No expiry label = 'default'. A malformed, duplicate or out-of-range label also gives
 * 'default' (with `invalid` set): BRC-177 says to reject those before funding, which is past by now, and a default
 * deadline is safer than none.
 */
export function policyFromLabels(labels: readonly string[] | undefined): ExpiryPolicy & { invalid?: string } {
  const mine = (labels ?? []).filter((l) => l.startsWith('p nosend expiry'));
  if (!mine.length) return { mode: 'default' };
  if (mine.length > 1) return { mode: 'default', invalid: 'duplicate expiry labels' };
  const l = mine[0];
  if (l === 'p nosend expiry never') return { mode: 'never' };
  const m = LABEL.exec(l);
  if (!m) return { mode: 'default', invalid: `malformed label "${l}"` };
  const value = Number(m[2]);
  if (!Number.isSafeInteger(value)) return { mode: 'default', invalid: 'value out of range' };
  const mode = m[1] as 'seconds' | 'timestamp' | 'blockheight';
  if (mode === 'seconds' && value === 0) return { mode: 'default', invalid: 'duration must be > 0' };
  return { mode, value };
}

/**
 * Has the deadline passed? `firstSeenS` is when this wallet first saw the action (the activation it can prove). Every
 * policy, `never` included, is capped at MAX_HOLD_S from first sight.
 */
export function isExpired(
  p: ExpiryPolicy,
  firstSeenS: number,
  nowS: number,
  height: number | undefined,
  defaultTtlS = DEFAULT_TTL_S,
): boolean {
  if (nowS >= firstSeenS + MAX_HOLD_S) return true;
  switch (p.mode) {
    case 'never':
      return false;
    case 'seconds':
      return nowS >= firstSeenS + p.value;
    case 'timestamp':
      return nowS >= p.value;
    case 'blockheight':
      return height !== undefined && height >= p.value;
    default:
      return nowS >= firstSeenS + defaultTtlS;
  }
}

// ── chain reads ──

/**
 * Is `spender` conclusively the spender of `outpoint` ("txid.vout")? autoCoinResync's rule (clearingSpender): the 1Sat
 * spend index and WhatsOnChain name the same spender, or WhatsOnChain calls the spend confirmed (and the index names
 * no other one). Any failure is "no". Used only to cancel a payment one of whose inputs that spender took (1).
 */
export type ConflictCheck = (outpoint: string, spender: string) => Promise<boolean>;
export const conflictCheck =
  (o: {
    /** 1Sat spend index (POST /1sat/txo/spends): spender, null unspent, undefined can't tell; throws when it can't. */
    index?: (outpoints: string[]) => Promise<(string | null | undefined)[]>;
    /** WhatsOnChain /tx/<txid>/<vout>/spent for "txid.vout": null unspent; throws when it can't tell. */
    woc: (outpoint: string) => Promise<WocAnswer>;
  }): ConflictCheck =>
  async (outpoint, spender) => {
    if (!splitOutpoint(outpoint) || !TXID.test(spender)) return false;
    const want = spender.toLowerCase();
    let ix: string | null | undefined;
    if (o.index) {
      try {
        const r = await o.index([outpoint]);
        const v = Array.isArray(r) && r.length === 1 ? r[0] : undefined;
        ix = typeof v === 'string' ? v.toLowerCase() : v === null ? null : undefined;
      } catch {
        ix = undefined;
      }
    }
    const isSpender = (t: unknown): t is string => typeof t === 'string' && TXID.test(t);
    const got = await clearingSpender(ix, () => o.woc(outpoint).catch(() => undefined), isSpender, true).catch(
      () => null,
    );
    return !!got && got.toLowerCase() === want;
  };

export type SpendState = { state: 'unspent' } | { state: 'spent'; by: string } | { state: 'unclear' };
/** Who spent an outpoint ("txid.vout"), confirmed or mempool. */
export type SpentLookup = (outpoint: string) => Promise<SpendState>;

type F = (url: string, init?: RequestInit) => Promise<Response>;

/** WhatsOnChain /tx/<txid>/<vout>/spent: 404 unspent, 200 {txid} spent (mempool or mined), anything else unclear. */
export const wocSpent =
  (f: F = (u, i) => fetch(u, i)): SpentLookup =>
  async (outpoint) => {
    const [txid, vout] = splitOutpoint(outpoint) ?? [];
    if (!txid) return { state: 'unclear' };
    try {
      const r = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`);
      if (r.status === 404) return { state: 'unspent' };
      if (!r.ok) return { state: 'unclear' };
      const j = (await r.json()) as { txid?: unknown };
      return typeof j.txid === 'string' && TXID.test(j.txid)
        ? { state: 'spent', by: j.txid.toLowerCase() }
        : { state: 'unclear' };
    } catch {
      return { state: 'unclear' };
    }
  };

/**
 * The chain height from WhatsOnChain /chain/info (`blocks`), as locks/verify.ts reads it. Any failure or odd answer
 * gives undefined, so a blockheight deadline is simply not due yet (fail closed: the action stays held).
 */
export const wocHeight =
  (f: F = (u, i) => fetch(u, i)) =>
  async (): Promise<number | undefined> => {
    try {
      const r = await f('https://api.whatsonchain.com/v1/bsv/main/chain/info');
      if (!r.ok) return undefined;
      const blocks = ((await r.json()) as { blocks?: unknown }).blocks;
      return typeof blocks === 'number' && Number.isSafeInteger(blocks) && blocks > 0 ? blocks : undefined;
    } catch {
      return undefined;
    }
  };

/** "txid.vout" or "txid_vout" → [txid, vout]; undefined when malformed. */
export function splitOutpoint(o: string): [string, number] | undefined {
  const m = /^([0-9a-f]{64})[._](\d{1,6})$/i.exec(o);
  return m ? [m[1].toLowerCase(), Number(m[2])] : undefined;
}

// ── state ──

export type ExpiryState = {
  /** txid → unix seconds this wallet first saw it as nosend. Never reset while the action stays nosend. */
  first: Record<string, number>;
  /** txid → unix seconds it was released (aborted) here; watched for WATCH_S. */
  released: Record<string, number>;
};
export type ExpiryKV = { load: () => Promise<ExpiryState | null>; save: (s: ExpiryState) => Promise<void> };

export const emptyState = (): ExpiryState => ({ first: {}, released: {} });

// ── the run ──

export type NoSendAction = {
  txid: string;
  labels?: string[];
  inputs?: { sourceOutpoint: string }[];
  /** For storeAsk: the action's description and its outputs' locking scripts (the Store memo). */
  description?: string;
  /** `basket`: the wallet basket the output went to (change: 'default'); empty for an output paying someone else. */
  outputs?: { lockingScript?: string; satoshis?: number; basket?: string | null }[];
};

/**
 * Whose Store payment a nosend action is (1b), read on this device only: 'not-store' (not a Store payment by the
 * wallet's own record), 'mine' (this device's Store flow made it: its txid and quote id are recorded here),
 * 'other-device' (a Store payment this device didn't make, e.g. synced from the phone).
 */
export type StoreKind = 'not-store' | 'mine' | 'other-device';
/** What the Store says (1b): 'never-heard' (it holds no such payment), 'heard' (paid or recorded), 'unclear'. */
export type StoreWord = 'never-heard' | 'heard' | 'unclear';

export type ExpiryDeps = {
  /** The wallet's nosend actions, with labels and inputs (toolbox listNoSendActions). */
  listNoSend: () => Promise<NoSendAction[]>;
  /** abortAction for one txid: returns its inputs to the wallet. */
  abort: (txid: string) => Promise<unknown>;
  /** The network has it: move it to sent through the wallet's send path (createAction sendWith). */
  sendWith?: (txid: string) => Promise<unknown>;
  /**
   * Conclusive foreign spend of an input (conflictCheck). Absent: any input spent elsewhere keeps the action, as before.
   */
  conflict?: ConflictCheck;
  /**
   * Before cancelling a payment whose input `outpoint` a confirmed foreign transaction spent: take that coin out of the
   * action (it no longer counts as held by `txid`) and leave it unspendable (spent by `spender`), so the abort does not
   * make it spendable again. Throws when it can't (the action is then kept). Required for the cancel in 1.
   */
  detachInput?: (txid: string, outpoint: string, spender: string) => Promise<void>;
  /**
   * After a cancel in 1: set the detached coin unspendable again (idempotent), so nothing in the abort (a toolbox that
   * re-reads its rawTx inputs, say) can have made it spendable. A failure is logged; the release stands.
   */
  reaffirmSpent?: (outpoint: string, spender: string) => Promise<void>;
  /**
   * The cancel in 1, done atomically: abort `txid` and set each [outpoint, spender] coin unspendable again, under one
   * exclusive storage lock (no coin selection in between). Returns the abort's result ({ aborted }); `remarked: false`
   * when the re-mark still failed after its retries (then reaffirmSpent is tried again outside the lock). Throws when
   * the abort fails. Absent: deps.abort, then reaffirmSpent.
   */
  abortRemarking?: (txid: string, remark: [string, string][]) => Promise<{ aborted?: unknown; remarked?: boolean }>;
  /**
   * The outputs (locking script hex + satoshis) of a transaction the chain has, or undefined when it can't be read.
   * Needed to cancel a payment whose EVERY input is spent elsewhere (1): only a spender that doesn't carry all of this
   * payment's outputs counts. Absent: such a payment is kept.
   */
  spenderOutputs?: (txid: string) => Promise<{ lockingScript: string; satoshis: number }[] | undefined>;
  /**
   * The active store's identity when detach + abort may run (this device's store active, no storage switch under way),
   * else null. Read inside the lock before the detach and again before the abort; any change keeps the action.
   */
  storageGate?: () => string | null;
  /** 1b: whose Store payment this is (local read). Absent: every action is 'not-store'. */
  storeKind?: (a: NoSendAction) => Promise<StoreKind>;
  /** 1b: has the Store heard of it? Asked only for 'mine'. Absent: no early Store release. */
  storeAsk?: (a: NoSendAction) => Promise<StoreWord>;
  /** The lock the final re-check and abort run under (withPayLock for Store payments). Default: none. */
  lock?: <T>(txid: string, fn: () => Promise<T>) => Promise<T>;
  storeMinAgeS?: number;
  /** The wallet's recovery for a txid the chain has (recoverByTxid). */
  recoverLate?: (txid: string) => Promise<unknown>;
  kv: ExpiryKV;
  lookups?: ChainLookup[];
  spent?: SpentLookup;
  height?: () => Promise<number | undefined>;
  nowS?: () => number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  defaultTtlS?: number;
  log?: (m: string) => void;
};

export type KeepReason =
  | 'not-due'
  | 'never'
  | 'no-inputs'
  | 'input-spent-elsewhere'
  | 'input-unclear'
  | 'parent-unknown'
  | 'chain-has-it-or-unclear'
  | 'changed-at-recheck'
  | 'store-heard'
  | 'store-unclear'
  | 'storage-busy'
  | 'abort-failed';

export type ExpiryReport = {
  checked: number;
  settled: string[];
  released: string[];
  kept: { txid: string; reason: KeepReason }[];
  lateSeen: string[];
  skipped?: 'rate-limited' | 'busy';
};

let lastRunAt = 0;
let running: Promise<ExpiryReport> | undefined;
/** Test hook. */
export function resetExpiryLimit() {
  lastRunAt = 0;
  running = undefined;
}

export async function runUnsentExpiry(deps: ExpiryDeps, opts: { force?: boolean } = {}): Promise<ExpiryReport> {
  const now = Date.now();
  const empty = (skipped: 'rate-limited' | 'busy'): ExpiryReport => ({
    checked: 0,
    settled: [],
    released: [],
    kept: [],
    lateSeen: [],
    skipped,
  });
  if (running) return empty('busy');
  if (!opts.force && lastRunAt && now - lastRunAt < MIN_INTERVAL_MS) return empty('rate-limited');
  lastRunAt = now;
  running = expireOnce(deps);
  try {
    return await running;
  } finally {
    running = undefined;
  }
}

const anySeen = async (txid: string, lookups: ChainLookup[]) => {
  for (const look of lookups) if ((await look(txid).catch((): Sighting => 'unclear')) === 'seen') return true;
  return false;
};

/** One pass (exported for tests; use runUnsentExpiry). Never throws. */
export async function expireOnce(deps: ExpiryDeps): Promise<ExpiryReport> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const lookups = deps.lookups ?? defaultLookups();
  const spent = deps.spent ?? wocSpent();
  const nowS = (deps.nowS ?? (() => Math.floor(Date.now() / 1000)))();
  const report: ExpiryReport = { checked: 0, settled: [], released: [], kept: [], lateSeen: [] };
  const keep = (txid: string, reason: KeepReason) => {
    report.kept.push({ txid, reason });
    if (reason !== 'not-due' && reason !== 'never' && reason !== 'store-heard')
      log(`[bwx-expiry] ${txid}: kept (${reason})`);
  };

  let state: ExpiryState;
  try {
    state = (await deps.kv.load()) ?? emptyState();
  } catch {
    state = emptyState();
  }
  state.first ??= {};
  state.released ??= {};

  let actions: NoSendAction[] = [];
  try {
    actions = (await deps.listNoSend())
      .filter((a) => TXID.test(a.txid))
      .map((a) => ({ ...a, txid: a.txid.toLowerCase() }));
  } catch (e) {
    log(`[bwx-expiry] could not list nosend actions (${e instanceof Error ? e.message : String(e)})`);
  }
  const listed = new Set(actions.map((a) => a.txid));
  for (const a of actions) state.first[a.txid] ??= nowS;
  // A txid no longer nosend was sent, aborted or failed elsewhere: forget its first-seen time.
  for (const t of Object.keys(state.first)) if (!listed.has(t)) delete state.first[t];

  let height: number | undefined;
  const needsHeight = actions.some((a) => policyFromLabels(a.labels).mode === 'blockheight');
  if (needsHeight && deps.height) height = await deps.height().catch(() => undefined);

  // 1. Which are due, and what the chain says about each due one.
  type Due = {
    a: NoSendAction;
    ownParents: Set<string>;
    foreign: Map<string, string>;
    storeEarly: boolean;
    /** Due only because an input is conclusively spent elsewhere (a Store payment made on another device, 1b). */
    conflictOnly: boolean;
    ttlS: number;
  };
  const due: Due[] = [];
  const storeMinAgeS = deps.storeMinAgeS ?? STORE_MIN_AGE_S;
  const baseTtlS = deps.defaultTtlS ?? DEFAULT_TTL_S;
  for (const a of actions) {
    report.checked++;
    const p = policyFromLabels(a.labels);
    // A kind that can't be read counts as another device's payment: the longest hold.
    const kind: StoreKind = deps.storeKind
      ? await deps.storeKind(a).catch((): StoreKind => 'other-device')
      : 'not-store';
    const ttlS = kind === 'other-device' ? Math.max(baseTtlS, STORE_OTHER_DEVICE_TTL_S) : baseTtlS;
    let storeEarly = false;
    let conflictOnly = false;
    if (!isExpired(p, state.first[a.txid], nowS, height, ttlS)) {
      // 1b. A Store payment this device made, which the Store has never heard of, is due early; every chain check
      // below still applies.
      if (kind === 'mine' && p.mode !== 'never' && deps.storeAsk && nowS >= state.first[a.txid] + storeMinAgeS) {
        const w = await deps.storeAsk(a).catch((): StoreWord => 'unclear');
        if (w === 'heard' || w === 'unclear') {
          keep(a.txid, w === 'heard' ? 'store-heard' : 'store-unclear');
          continue;
        }
        storeEarly = w === 'never-heard';
        if (storeEarly) log(`[bwx-expiry] ${a.txid}: a Store payment the Store never heard of; checking the chain`);
      } else if (kind === 'other-device' && isExpired(p, state.first[a.txid], nowS, height, baseTtlS)) {
        // Another device's Store payment past the usual 24 h: released early only if it can never be mined (1).
        conflictOnly = true;
      }
      if (!storeEarly && !conflictOnly) {
        keep(a.txid, p.mode === 'never' ? 'never' : 'not-due');
        continue;
      }
    }
    if (p.mode !== 'default' && nowS >= state.first[a.txid] + MAX_HOLD_S)
      log(`[bwx-expiry] ${a.txid}: held ${MAX_HOLD_S / 86400} days (the most we allow), checking it like any deadline`);
    if ((p as { invalid?: string }).invalid)
      log(`[bwx-expiry] ${a.txid}: ${(p as { invalid?: string }).invalid}; using the default deadline`);
    if (await anySeen(a.txid, lookups)) {
      await settle(a.txid);
      continue;
    }
    const ins = (a.inputs ?? []).map((i) => i.sourceOutpoint);
    if (!ins.length || ins.some((o) => !splitOutpoint(o))) {
      keep(a.txid, 'no-inputs');
      continue;
    }
    const verdict = await checkInputs(a, ins, listed);
    if (verdict === 'seen') {
      await settle(a.txid);
      continue;
    }
    if (typeof verdict === 'string') {
      keep(a.txid, verdict);
      continue;
    }
    if (conflictOnly && !verdict.foreign.size) {
      keep(a.txid, 'not-due');
      continue;
    }
    if (verdict.foreign.size) {
      if (!deps.detachInput) {
        keep(a.txid, 'input-spent-elsewhere');
        continue;
      }
      for (const [o, by] of verdict.foreign)
        log(
          `[bwx-expiry] ${a.txid}: input ${o} was spent on chain by ${by} (confirmed, or named by both sources); this payment can never be mined`,
        );
    }
    due.push({ a, ownParents: verdict.ownParents, foreign: verdict.foreign, storeEarly, conflictOnly, ttlS });
  }

  // 2. Inputs from our own nosend parents count only when that parent is released in this run too.
  let changed = true;
  let candidates = due;
  while (changed) {
    const ids = new Set(candidates.map((d) => d.a.txid));
    const next = candidates.filter((d) => [...d.ownParents].every((p) => ids.has(p)));
    changed = next.length !== candidates.length;
    for (const d of candidates) if (!next.includes(d)) keep(d.a.txid, 'parent-unknown');
    candidates = next;
  }

  // 3. The full ~30 s "missing everywhere" check, then a last look at the inputs, then release (children first).
  const cleared: Due[] = [];
  for (const d of candidates) {
    if (!(await chainSaysUnknown(d.a.txid, { lookups, delaysMs: deps.delaysMs, sleep: deps.sleep }))) {
      keep(d.a.txid, 'chain-has-it-or-unclear');
      continue;
    }
    cleared.push(d);
  }
  const clearedIds = new Set(cleared.map((d) => d.a.txid));
  const ordered = orderChildrenFirst(cleared);
  const blocked = new Set<string>();
  const underLock = deps.lock ?? (<T>(_t: string, fn: () => Promise<T>) => fn());
  for (const d of ordered) {
    const t = d.a.txid;
    // A child that stayed held keeps its parents held too.
    if (blocked.has(t)) {
      keep(t, 'parent-unknown');
      continue;
    }
    const ok = await underLock(t, () => finalCheckAndRelease(d)).catch((e: unknown) => {
      keep(t, 'abort-failed');
      log(`[bwx-expiry] ${t}: release failed (${e instanceof Error ? e.message : String(e)})`);
      return false;
    });
    if (!ok) for (const p of d.ownParents) blocked.add(p);
  }

  // 4. Watch earlier releases: if the original turns up after all, recover its outputs.
  for (const [t, at] of Object.entries(state.released)) {
    if (report.released.includes(t)) continue;
    if (nowS - at > WATCH_S) {
      delete state.released[t];
      continue;
    }
    if (!(await anySeen(t, lookups))) continue;
    report.lateSeen.push(t);
    log(`[bwx-expiry] ${t}: released earlier, but the network has it now; running recovery`);
    try {
      if (deps.recoverLate) {
        await deps.recoverLate(t);
        delete state.released[t];
      }
    } catch (e) {
      log(`[bwx-expiry] ${t}: recovery failed, will retry (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  try {
    await deps.kv.save(state);
  } catch {
    /* next run sees them again as new: deadlines only move later, never earlier */
  }
  return report;

  /** The last look at the inputs (and, for an early Store release, at the Store), then the release. True if released. */
  async function finalCheckAndRelease(d: Due): Promise<boolean> {
    const t = d.a.txid;
    const ins = (d.a.inputs ?? []).map((i) => i.sourceOutpoint);
    const again = await checkInputs(d.a, ins, listed);
    if (again === 'seen') {
      await settle(t);
      return false;
    }
    if (typeof again === 'string' || [...again.ownParents].some((p) => !clearedIds.has(p))) {
      keep(t, 'changed-at-recheck');
      return false;
    }
    if (again.foreign.size && !deps.detachInput) {
      keep(t, 'input-spent-elsewhere');
      return false;
    }
    if (d.conflictOnly && !again.foreign.size && !isExpiredNow(d)) {
      keep(t, 'changed-at-recheck');
      return false;
    }
    if (d.storeEarly && !isExpiredNow(d)) {
      const w = await deps.storeAsk!(d.a).catch((): StoreWord => 'unclear');
      if (w !== 'never-heard') {
        keep(t, w === 'heard' ? 'store-heard' : 'store-unclear');
        return false;
      }
    }
    // The same active store for the detach and the abort, and no storage switch under way.
    const gate = () => (deps.storageGate ? deps.storageGate() : 'any');
    const store = gate();
    if (!store) {
      keep(t, 'storage-busy');
      return false;
    }
    const remark = [...again.foreign];
    let remarked = !remark.length;
    try {
      // Coins a confirmed foreign transaction spent: detached first (unspendable, recorded for the coin check). The
      // toolbox's abort frees every input it finds in the raw tx, these included, so they are re-marked after it.
      for (const [o, by] of remark) await deps.detachInput!(t, o, by);
      if (gate() !== store) {
        keep(t, 'storage-busy');
        return false;
      }
      const r =
        remark.length && deps.abortRemarking
          ? await deps.abortRemarking(t, remark)
          : ((await deps.abort(t)) as { aborted?: unknown; remarked?: boolean } | undefined);
      if (r && typeof r === 'object' && r.aborted === false) throw new Error('the wallet did not abort it');
      if (remark.length && deps.abortRemarking) remarked = r?.remarked !== false;
    } catch (e) {
      keep(t, 'abort-failed');
      log(`[bwx-expiry] ${t}: abort refused by the wallet (${e instanceof Error ? e.message : String(e)})`);
      return false;
    }
    // Not re-marked inside the lock (not wired, or it failed): try again, a few times.
    for (const [o, by] of remarked ? [] : remark) {
      let last: unknown;
      for (let i = 0; i < 3; i++) {
        last = undefined;
        try {
          await deps.reaffirmSpent?.(o, by);
          break;
        } catch (e) {
          last = e;
        }
      }
      if (last)
        log(
          `[bwx-expiry] ${t}: could not re-mark ${o} spent (${last instanceof Error ? last.message : String(last)}); the coin check clears it`,
        );
    }
    state.released[t] = nowS;
    delete state.first[t];
    report.released.push(t);
    log(
      again.foreign.size
        ? `[bwx-expiry] ${t}: ${again.foreign.size} input(s) conclusively spent on chain by another transaction and no copy of this one anywhere after retries; cancelled (aborted), the other inputs are spendable again`
        : d.storeEarly
          ? `[bwx-expiry] ${t}: Store payment the Store never heard of, inputs unspent on chain and no copy anywhere after retries; released (aborted)`
          : `[bwx-expiry] ${t}: deadline passed, inputs unspent on chain and no copy anywhere after retries; released (aborted)`,
    );
    return true;
  }

  function isExpiredNow(d: Due): boolean {
    return isExpired(policyFromLabels(d.a.labels), state.first[d.a.txid] ?? nowS, nowS, height, d.ttlS);
  }

  async function settle(txid: string) {
    report.settled.push(txid);
    if (!deps.sendWith) return log(`[bwx-expiry] ${txid}: on chain; left for the wallet's review (no send path)`);
    try {
      await deps.sendWith(txid);
      log(`[bwx-expiry] ${txid}: on chain; handed to the wallet's send path`);
    } catch (e) {
      log(`[bwx-expiry] ${txid}: on chain but the send path failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /**
   * 'seen' when an input is spent by this very txid; a KeepReason to keep; else the set of our own nosend parents
   * (whose outputs the chain can't know yet) and the inputs a different transaction conclusively spent (`foreign`,
   * outpoint → spender; deps.conflict). Every other input must be cleanly unspent with a parent the chain has.
   */
  async function checkInputs(
    a: NoSendAction,
    ins: string[],
    own: Set<string>,
  ): Promise<'seen' | KeepReason | { ownParents: Set<string>; foreign: Map<string, string> }> {
    const txid = a.txid;
    const ownParents = new Set<string>();
    const foreign = new Map<string, string>();
    for (const o of ins) {
      const [parent] = splitOutpoint(o)!;
      if (own.has(parent) && parent !== txid) {
        ownParents.add(parent);
        continue;
      }
      const s = await spent(o).catch((): SpendState => ({ state: 'unclear' }));
      if (s.state === 'spent') {
        if (s.by === txid) return 'seen';
        // Spent by another transaction: this one can never be mined, but only a conclusive spend (confirmed, or named
        // by both sources) by something that is not one of our own unsent actions counts (1).
        const by = s.by.toLowerCase();
        if (!deps.conflict || own.has(by) || !(await deps.conflict(o, by).catch(() => false)))
          return 'input-spent-elsewhere';
        foreign.set(o, by);
        continue;
      }
      if (s.state !== 'unspent') return 'input-unclear';
      // A 404 from the spent lookup also comes back for an outpoint the chain has never heard of.
      if (!(await anySeen(parent, lookups))) return 'parent-unknown';
    }
    // A spender may be this very payment, re-signed (another fee, other coins added) or malleated: kept unless the
    // spenders are all readable and, together, don't pay every one of this payment's own payment outputs.
    if (foreign.size && !(await spendersAreOthers(a, new Set(foreign.values())))) return 'input-spent-elsewhere';
    return { ownParents, foreign };
  }

  /**
   * True only when every spender's outputs can be read and, all spenders' outputs taken together, at least one of
   * `a`'s payment outputs (to others: not wallet change, not a 0-sat OP_RETURN) is missing. Anything unclear: false.
   */
  async function spendersAreOthers(a: NoSendAction, spenders: Set<string>): Promise<boolean> {
    const outs = a.outputs ?? [];
    if (!deps.spenderOutputs || !outs.length) return false;
    if (outs.some((o) => !o.lockingScript || typeof o.satoshis !== 'number')) return false;
    const mine = outs
      .filter((o) => !o.basket && !(o.satoshis === 0 && isOpReturn(o.lockingScript!)))
      .map((o) => `${o.lockingScript!.toLowerCase()}:${o.satoshis}`);
    if (!mine.length) {
      log(`[bwx-expiry] ${a.txid}: no payment output to tell it from a copy of itself; kept`);
      return false;
    }
    const union: string[] = [];
    for (const by of spenders) {
      const theirs = await deps.spenderOutputs(by).catch(() => undefined);
      if (!theirs) return false;
      for (const o of theirs) union.push(`${o.lockingScript.toLowerCase()}:${o.satoshis}`);
    }
    const carriesAll = mine.every((k) => {
      const i = union.indexOf(k);
      if (i < 0) return false;
      union.splice(i, 1);
      return true;
    });
    if (carriesAll) {
      log(`[bwx-expiry] ${a.txid}: its inputs' spenders pay all of this payment's outputs (a re-signed copy?); kept`);
      return false;
    }
    return true;
  }
}

/** OP_RETURN / OP_FALSE OP_RETURN. */
const isOpReturn = (scriptHex: string) => /^(00)?6a/i.test(scriptHex);

/** Children (spending another cleared one's output) before their parents. */
function orderChildrenFirst<T extends { a: { txid: string }; ownParents: Set<string> }>(xs: T[]): T[] {
  const out: T[] = [];
  const done = new Set<string>();
  const byId = new Map(xs.map((x) => [x.a.txid, x]));
  const childrenOf = (id: string) => xs.filter((x) => x.ownParents.has(id));
  const visit = (x: T, path: Set<string>) => {
    if (done.has(x.a.txid) || path.has(x.a.txid)) return;
    path.add(x.a.txid);
    for (const c of childrenOf(x.a.txid)) visit(c, path);
    done.add(x.a.txid);
    out.push(x);
  };
  for (const x of xs) visit(x, new Set());
  return out.filter((x) => byId.has(x.a.txid));
}

// ── detaching a coin a confirmed foreign transaction spent (1) ──

type DetachRow = { outputId: number; spendable?: boolean; spentBy?: number | null };
type DetachTx = { transactionId: number; status: string };
/** The few storage calls detachInput needs (a StorageProvider, as runAsStorageProvider hands it over). */
export type DetachProvider = {
  findTransactions: (args: { partial: { userId: number; txid: string }; noRawTx: true }) => Promise<DetachTx[]>;
  findOutputs: (args: {
    partial: { userId: number; txid: string; vout: number };
    noScript: true;
  }) => Promise<DetachRow[]>;
  updateOutput: (outputId: number, patch: { spendable: boolean; spentBy?: number }) => Promise<number>;
};

/**
 * ExpiryDeps.detachInput on the wallet's storage: on this device's own store only (fails otherwise), with the action
 * still 'nosend', the row(s) for `outpoint` that the action holds (spentBy = its transactionId) are set unspendable and
 * linked to `spender` when storage holds it (else unlinked). This alone does NOT keep the abort from freeing them: the
 * toolbox's abort also finds inputs through the raw tx and makes them spendable; the re-mark inside the abort's
 * exclusive lock (storageAbortRemarking) is what keeps them out. Spendability only goes down. `recordCleared` hands the coin to the automatic coin check's cleared list (outpoint "txid_vout" →
 * spender), which puts it back if both chain sources later call it unspent (autoCoinResync).
 */
export const storageDetachInput =
  (s: {
    isActive: () => boolean;
    userId: () => Promise<number>;
    run: <T>(fn: (sp: DetachProvider) => Promise<T>) => Promise<T>;
    recordCleared?: (outpoint: string, spender: string) => Promise<void>;
  }) =>
  async (txid: string, outpoint: string, spender: string): Promise<void> => {
    const op = splitOutpoint(outpoint);
    if (!op || !TXID.test(txid) || !TXID.test(spender)) throw new Error('bad outpoint or txid');
    if (!s.isActive()) throw new Error("this device's store is not the active one");
    const userId = await s.userId();
    const [ptxid, vout] = op;
    await s.run(async (sp) => {
      const [action] = await sp.findTransactions({ partial: { userId, txid: txid.toLowerCase() }, noRawTx: true });
      if (!action || action.status !== 'nosend') throw new Error(`the payment is ${action?.status ?? 'gone'} now`);
      const [by] = await sp.findTransactions({ partial: { userId, txid: spender.toLowerCase() }, noRawTx: true });
      for (const o of await sp.findOutputs({ partial: { userId, txid: ptxid, vout }, noScript: true }))
        if (o.spentBy === action.transactionId)
          await sp.updateOutput(o.outputId, { spendable: false, spentBy: by ? by.transactionId : undefined });
    });
    await s.recordCleared?.(`${ptxid}_${vout}`, spender.toLowerCase()).catch(() => undefined);
  };

/**
 * ExpiryDeps.reaffirmSpent on the wallet's storage: after the abort, any row for `outpoint` that is spendable with no
 * spender is set unspendable again (linked to `spender` when storage holds it). Idempotent; this device's store only.
 */
export const storageReaffirmSpent =
  (s: {
    isActive: () => boolean;
    userId: () => Promise<number>;
    run: <T>(fn: (sp: DetachProvider) => Promise<T>) => Promise<T>;
  }) =>
  async (outpoint: string, spender: string): Promise<void> => {
    const op = splitOutpoint(outpoint);
    if (!op || !TXID.test(spender)) throw new Error('bad outpoint or txid');
    if (!s.isActive()) throw new Error("this device's store is not the active one");
    const userId = await s.userId();
    await s.run((sp) => remarkOn(sp, userId, outpoint, spender));
  };

/** Set `outpoint`'s spendable rows with no spender unspendable again (linked to `spender` when storage holds it). */
async function remarkOn(sp: DetachProvider, userId: number, outpoint: string, spender: string): Promise<void> {
  const op = splitOutpoint(outpoint);
  if (!op || !TXID.test(spender)) throw new Error('bad outpoint or txid');
  const [ptxid, vout] = op;
  const [by] = await sp.findTransactions({ partial: { userId, txid: spender.toLowerCase() }, noRawTx: true });
  for (const o of await sp.findOutputs({ partial: { userId, txid: ptxid, vout }, noScript: true }))
    if (o.spendable === true && o.spentBy == null)
      await sp.updateOutput(o.outputId, { spendable: false, spentBy: by ? by.transactionId : undefined });
}

/**
 * ExpiryDeps.abortRemarking on the wallet's storage: inside ONE runAsStorageProvider (the storage manager's exclusive
 * lock: reader, writer, sync and provider locks, so no createAction / listOutputs / coin selection runs in between),
 * the provider's own abortAction (what Wallet.abortAction calls, through the writer lock) and then the re-mark of each
 * coin, retried up to 3 times. The toolbox's abort frees every input it finds in the raw tx, the detached ones too;
 * they are unspendable again before the lock is released. Throws if the abort throws; `remarked: false` if a re-mark
 * still failed.
 */
export const storageAbortRemarking =
  (s: {
    isActive: () => boolean;
    auth: () => Promise<AuthId>;
    run: <T>(fn: (sp: DetachProvider & AbortProvider) => Promise<T>) => Promise<T>;
  }) =>
  async (txid: string, remark: [string, string][]): Promise<{ aborted?: unknown; remarked: boolean }> => {
    if (!TXID.test(txid)) throw new Error('not a txid');
    if (!s.isActive()) throw new Error("this device's store is not the active one");
    const auth = await s.auth();
    if (auth.userId == null) throw new Error('no user');
    const userId = auth.userId;
    return s.run(async (sp) => {
      const r = (await sp.abortAction(auth, { reference: txid })) as { aborted?: unknown } | undefined;
      if (r && r.aborted === false) return { aborted: false, remarked: true };
      let remarked = true;
      for (const [o, by] of remark) {
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++)
          ok = await remarkOn(sp, userId, o, by).then(
            () => true,
            () => false,
          );
        remarked &&= ok;
      }
      return { aborted: r?.aborted ?? true, remarked };
    });
  };
/** The storage manager's auth (the toolbox's AuthId). */
export type AuthId = { identityKey: string; userId?: number; isActive?: boolean };
/** The provider's abortAction (StorageProvider.abortAction(auth, args)). */
export type AbortProvider = {
  abortAction: (auth: AuthId, args: { reference: string }) => Promise<unknown>;
};

/**
 * State in chrome.storage.local (the mobile and web builds shim it), else localStorage; one key per identity, so
 * accounts never share deadlines.
 */
export function storageKV(identityKey: string): ExpiryKV {
  const key = `bwx.unsentExpiry.v1.${identityKey.slice(0, 16)}`;
  const local = (globalThis as { chrome?: { storage?: { local?: ChromeLocal } } }).chrome?.storage?.local;
  return {
    load: async () => {
      if (local) return ((await local.get(key))[key] as ExpiryState | undefined) ?? null;
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? (JSON.parse(raw) as ExpiryState) : null;
    },
    save: async (s) => {
      if (local) await local.set({ [key]: s });
      else globalThis.localStorage?.setItem(key, JSON.stringify(s));
    },
  };
}
type ChromeLocal = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};
