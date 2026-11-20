/**
 * Business agent account: a capped account a room's business agent pays from (refunds today), with a daily
 * limit and a Stop button. Mirrors the bwalletx CLI's capped agent wallet (gate.ts: stop → daily cap).
 *
 * Non-custodial: the key is never stored anywhere. It is derived on the device from the owner's wallet (an HMAC
 * under a BRC-42 'self' key, protocol [2,'bwalletx business agent'], keyID = the room ticker), so the same seed
 * always gives the same agent account and the owner can recover its coins from the seed alone. Our server never
 * sees it. Storage keeps only { ticker, address, cap, stopped } and the activity log.
 *
 * ⚠ Every agent payment goes through `bizAgentPay`, which checks Stop and the daily cap BEFORE fetching coins and
 * AGAIN immediately before signing, and books the spend (as 'pending') before broadcasting, so a Stop pressed
 * mid-payment or two payments racing can never go past the cap.
 *
 * A broadcast that errs or times out is unsure, never 'failed' (task 72 review): the tx may have reached the network (a
 * refund that timed out but landed, then a second tap, refunded twice). It stays pending with its signed tx, in its own
 * store that the log's trim never touches, and nothing new is signed for that room until it is seen on chain (paid) or
 * proven INVALID/MALFORMED, or the owner writes it off. A payment written off and made again spends one of the old tx's
 * inputs, so at most one of the two can ever confirm. The same payment (same key) is paid at most once: a tap for it
 * always gets the earlier txid back. Check, sign and record run under one lock per room across tabs (navigator.locks).
 */
import {
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  PublicKey,
  Random,
  SatoshisPerKilobyte,
  Transaction,
  Utils,
  type WalletInterface,
} from '@bsv/sdk';
import { allAgentsStopped } from '../agentAccounts';

export const BIZ_AGENT_PROTOCOL: [2, string] = [2, 'bwalletx business agent'];
export const DEFAULT_DAILY_CAP_USD = 10;
export const MAX_DAILY_CAP_USD = 1000;
const FEE_SATS_PER_KB = 100;
const KEY = 'bwallet.bizAgent';
const LOG = (t: string) => `bwallet.bizAgentLog.${t}`;
const LOG_MAX = 300;
const EVENT = 'bwallet:bizagent';

export type BizAgentState = {
  ticker: string;
  /** The derived key's P2PKH address: fund it to give the agent its budget. */
  address: string;
  /** Most the agent may pay out per UTC day, in USD. Always set (a business agent account has no "no cap"). */
  dailyCapUsd: number;
  stopped: boolean;
  createdAt: number;
};

export type BizLogEntry = {
  at: number;
  /** 'create' | 'cap' | 'stop' | 'resume' | 'pending' | 'paid' | 'failed' | 'refused' | 'sweep' */
  action: string;
  detail: string;
  /** Dollars this entry counts toward today's cap ('pending', 'paid' and 'failed' only). */
  usd: number;
  txid?: string;
  id?: string;
  /** A 'pending' entry written before task 72's re-check: the signed tx (now kept in the pending store, BizPending). */
  rawTx?: string;
  /** What was paid (to, sats, data). */
  key?: string;
};

export const normTicker = (t: string) =>
  String(t ?? '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase();

// ── key ──────────────────────────────────────────────────────────────────────
export async function deriveBizAgentKey(
  wallet: Pick<WalletInterface, 'createHmac'>,
  ticker: string,
): Promise<PrivateKey> {
  const t = normTicker(ticker);
  if (!t) throw new Error('No room');
  const { hmac } = await wallet.createHmac({
    data: Utils.toArray(`bwalletx business agent:${t}`, 'utf8'),
    protocolID: BIZ_AGENT_PROTOCOL,
    keyID: t,
    counterparty: 'self',
  });
  return new PrivateKey(Utils.toHex(hmac), 16);
}

// ── storage (only public data) ───────────────────────────────────────────────
type KV = Pick<Storage, 'getItem' | 'setItem'>;
const kv = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const readJson = <T>(s: KV | null, k: string, fb: T): T => {
  try {
    const v = s?.getItem(k);
    return v ? (JSON.parse(v) as T) : fb;
  } catch {
    return fb;
  }
};
const writeJson = (s: KV | null, k: string, v: unknown) => {
  try {
    s?.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};
export const onBizAgentChange = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

type Store = Record<string, BizAgentState>;
export const getBizAgent = (ticker: string, s: KV | null = kv()): BizAgentState | null =>
  readJson<Store>(s, KEY, {})[normTicker(ticker)] ?? null;
const saveState = (a: BizAgentState, s: KV | null) =>
  writeJson(s, KEY, { ...readJson<Store>(s, KEY, {}), [a.ticker]: a });

export const getBizLog = (ticker: string, s: KV | null = kv()): BizLogEntry[] =>
  readJson<BizLogEntry[]>(s, LOG(normTicker(ticker)), []);
const appendLog = (ticker: string, e: BizLogEntry, s: KV | null) =>
  writeJson(s, LOG(normTicker(ticker)), [e, ...getBizLog(ticker, s)].slice(0, LOG_MAX));
const replaceLog = (ticker: string, id: string, e: BizLogEntry, s: KV | null) =>
  writeJson(
    s,
    LOG(normTicker(ticker)),
    getBizLog(ticker, s).map((x) => (x.id === id ? e : x)),
  );

export const cleanCap = (usd: number) =>
  Number.isFinite(usd) && usd > 0 ? Math.min(MAX_DAILY_CAP_USD, Math.round(usd * 100) / 100) : null;

/** Turn on the agent account for a room: derive the key (only its address is kept), starts with a cap. */
export async function createBizAgent(
  wallet: Pick<WalletInterface, 'createHmac'>,
  ticker: string,
  dailyCapUsd = DEFAULT_DAILY_CAP_USD,
  s: KV | null = kv(),
  now = Date.now(),
): Promise<BizAgentState> {
  const existing = getBizAgent(ticker, s);
  if (existing) return existing;
  const key = await deriveBizAgentKey(wallet, ticker);
  const a: BizAgentState = {
    ticker: normTicker(ticker),
    address: key.toAddress(),
    dailyCapUsd: cleanCap(dailyCapUsd) ?? DEFAULT_DAILY_CAP_USD,
    stopped: false,
    createdAt: now,
  };
  saveState(a, s);
  appendLog(
    a.ticker,
    { at: now, action: 'create', detail: `Agent account created ($${a.dailyCapUsd}/day)`, usd: 0 },
    s,
  );
  return a;
}

export const setBizCap = (ticker: string, usd: number, s: KV | null = kv(), now = Date.now()) => {
  const a = getBizAgent(ticker, s);
  const cap = cleanCap(usd);
  if (!a || cap === null || cap === a.dailyCapUsd) return;
  saveState({ ...a, dailyCapUsd: cap }, s);
  appendLog(a.ticker, { at: now, action: 'cap', detail: `Daily limit set to $${cap}`, usd: 0 }, s);
};

/** Stop / Resume. Stop takes effect for every payment not yet signed, including one already in progress. */
export const setBizStopped = (ticker: string, stopped: boolean, s: KV | null = kv(), now = Date.now()) => {
  const a = getBizAgent(ticker, s);
  if (!a || a.stopped === stopped) return;
  saveState({ ...a, stopped }, s);
  appendLog(
    a.ticker,
    { at: now, action: stopped ? 'stop' : 'resume', detail: stopped ? 'Stopped by you' : 'Resumed', usd: 0 },
    s,
  );
};

// ── the gate ─────────────────────────────────────────────────────────────────
const dayStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Dollars booked today (UTC): paid, pending, and failed broadcasts (they may still have gone out). */
export const bizSpentToday = (log: BizLogEntry[], now = Date.now()) =>
  log
    .filter((e) => e.at >= dayStart(now) && (e.action === 'paid' || e.action === 'pending' || e.action === 'failed'))
    .reduce((sum, e) => sum + (e.usd > 0 ? e.usd : 0), 0);

export type BizCheck = { ok: true } | { ok: false; reason: string };

/** Pure: no account, Stop all, Stop, a bad amount, or over today's cap → refused. */
export const bizSpendAllowed = (
  a: BizAgentState | null,
  stopAll: boolean,
  log: BizLogEntry[],
  usd: number,
  now = Date.now(),
): BizCheck => {
  if (!a) return { ok: false, reason: 'No agent account for this room' };
  if (stopAll) return { ok: false, reason: 'All agents are stopped' };
  if (a.stopped) return { ok: false, reason: 'The agent account is stopped' };
  if (!(usd > 0) || !Number.isFinite(usd)) return { ok: false, reason: 'Unknown amount' };
  const left = a.dailyCapUsd - bizSpentToday(log, now);
  if (usd > left + 1e-9)
    return { ok: false, reason: `Over today's limit ($${Math.max(0, left).toFixed(2)} left of $${a.dailyCapUsd})` };
  return { ok: true };
};

export const checkBizSpend = (ticker: string, usd: number, s: KV | null = kv(), now = Date.now()) =>
  bizSpendAllowed(getBizAgent(ticker, s), allAgentsStopped(), getBizLog(ticker, s), usd, now);

// ── paying ───────────────────────────────────────────────────────────────────
export type BizCoin = { txid: string; vout: number; sats: number; sourceTx: Transaction };

/**
 * Where a txid stands: 'seen' (on the network or mined), 'rejected' (INVALID or MALFORMED only: the tx itself can never
 * be valid), 'missing' (the network service never heard of it), 'unknown' (anything else, REJECTED and
 * DOUBLE_SPEND_ATTEMPTED included: one node's policy, or a conflict that may still lose; the tx may yet be mined).
 */
export type BizTxStatus = 'seen' | 'rejected' | 'missing' | 'unknown';

/** The longest a broadcast, a status check or a coin lookup is waited for: past it, the payment is unsure. */
export const BIZ_BROADCAST_TIMEOUT_MS = 30_000;

/** A lock held across check, sign and record for one room, across tabs (navigator.locks) where the browser has it. */
export type BizLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type BizPayDeps = {
  wallet: Pick<WalletInterface, 'createHmac'>;
  /** Unspent coins of an address with their source txs. */
  findCoins: (address: string) => Promise<BizCoin[]>;
  broadcast: (rawTx: string) => Promise<void>;
  /** Where an earlier payment's txid stands (defaultBizTxStatus). Absent: 'unknown'. */
  txStatus?: (txid: string) => Promise<BizTxStatus>;
  /** Bound on one broadcast, status check or coin lookup (default BIZ_BROADCAST_TIMEOUT_MS). */
  broadcastTimeoutMs?: number;
  /** USD per BSV now; the cap is checked on sats × rate (never on a figure the server sent). */
  usdPerBsv: number;
  stopAll?: () => boolean;
  store?: KV | null;
  now?: () => number;
  /** Default: navigator.locks, else a lock within this tab. */
  lock?: BizLock;
};

/**
 * One payment. Its key (address, sats, data) names the intent: a refund's data carries the order's reference
 * (chat/businessAgent.ts refundCheck), so the same key is the same refund, and is paid at most once, ever.
 */
export type BizPayment = { ticker: string; address: string; sats: number; data?: string[]; detail: string };
export type BizPayResult =
  | { ok: true; txid: string; usd: number }
  /** pending: signed and posted, outcome unknown; nothing new is paid from this room until it settles. */
  | { ok: false; reason: string; pending?: true; txid?: string };

/** A signed payment whose outcome is not known yet. Kept under its own key, never trimmed with the activity log. */
export type BizPending = {
  txid: string;
  key: string;
  usd: number;
  detail: string;
  at: number;
  /** The signed tx: only this tx is ever posted for the payment. Absent on an entry from before it was kept. */
  rawTx?: string;
  /** Its inputs ("txid.vout"): a replacement after a write-off must spend one of them. */
  inputs?: string[];
};
/** A pending payment written off (refused as INVALID/MALFORMED, or by the owner): its replacement must share an input. */
type BizWrittenOff = { txid: string; inputs: string[]; at: number };
/** A payment known to be out, by its key: the same payment tapped again gets this txid, always. */
type BizDone = { txid: string; usd: number; at: number };

const PENDING_KEY = (t: string) => `bwallet.bizAgentPending.${t}`;
const DONE_KEY = (t: string) => `bwallet.bizAgentDone.${t}`;
const WRITTEN_OFF_KEY = (t: string) => `bwallet.bizAgentWrittenOff.${t}`;

/** Pending payments of a room: its own store, plus any 'pending' log entry from before it existed (no signed tx). */
export const getBizPending = (ticker: string, s: KV | null = kv()): BizPending[] => {
  const t = normTicker(ticker);
  const own = readJson<Record<string, BizPending>>(s, PENDING_KEY(t), {});
  const legacy = getBizLog(t, s)
    .filter((e) => e.action === 'pending' && e.txid && !own[e.txid])
    .map((e) => ({
      txid: e.txid!,
      key: e.key ?? `legacy:${e.txid}`,
      usd: e.usd,
      detail: e.detail,
      at: e.at,
      ...(e.rawTx ? { rawTx: e.rawTx } : {}),
    }));
  return [...Object.values(own), ...legacy].sort((a, b) => a.at - b.at);
};
const putPending = (t: string, p: BizPending, s: KV | null) =>
  writeJson(s, PENDING_KEY(t), { ...readJson<Record<string, BizPending>>(s, PENDING_KEY(t), {}), [p.txid]: p });
const dropPending = (t: string, txid: string, s: KV | null) => {
  const all = readJson<Record<string, BizPending>>(s, PENDING_KEY(t), {});
  delete all[txid];
  writeJson(s, PENDING_KEY(t), all);
};
const doneFor = (t: string, key: string, s: KV | null): BizDone | undefined =>
  readJson<Record<string, BizDone>>(s, DONE_KEY(t), {})[key];
const writtenOffFor = (t: string, key: string, s: KV | null): BizWrittenOff | undefined =>
  readJson<Record<string, BizWrittenOff>>(s, WRITTEN_OFF_KEY(t), {})[key];
const setWrittenOff = (t: string, key: string, w: BizWrittenOff | undefined, s: KV | null) => {
  const all = readJson<Record<string, BizWrittenOff>>(s, WRITTEN_OFF_KEY(t), {});
  if (w) all[key] = w;
  else delete all[key];
  writeJson(s, WRITTEN_OFF_KEY(t), all);
};
/** Log one entry by id: replaced where it is, else added at the top. */
const upsertLog = (t: string, e: BizLogEntry & { id: string }, s: KV | null) =>
  getBizLog(t, s).some((x) => x.id === e.id) ? replaceLog(t, e.id, e, s) : appendLog(t, e, s);

const inputsOf = (rawTx: string): string[] => {
  try {
    return Transaction.fromHex(rawTx).inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`);
  } catch {
    return [];
  }
};

/** The payment is out: off the pending list, on the done list by its key, 'paid' in the log. */
const markPaid = (t: string, p: BizPending, at: number, s: KV | null) => {
  dropPending(t, p.txid, s);
  writeJson(s, DONE_KEY(t), {
    ...readJson<Record<string, BizDone>>(s, DONE_KEY(t), {}),
    [p.key]: { txid: p.txid, usd: p.usd, at },
  });
  upsertLog(t, { at, action: 'paid', detail: p.detail, usd: p.usd, txid: p.txid, id: p.txid, key: p.key }, s);
};

/** Written off: its inputs are kept, so the same payment's replacement must spend one of them (at most one confirms). */
const writeOff = (t: string, p: BizPending, why: string, at: number, s: KV | null) => {
  const inputs = p.inputs ?? (p.rawTx ? inputsOf(p.rawTx) : []);
  const before = writtenOffFor(t, p.key, s);
  setWrittenOff(t, p.key, { txid: p.txid, inputs: [...new Set([...(before?.inputs ?? []), ...inputs])], at }, s);
  dropPending(t, p.txid, s);
  upsertLog(t, { at, action: 'failed', detail: `${p.detail}: ${why}`, usd: p.usd, txid: p.txid, id: p.txid }, s);
};

/**
 * The owner writes a pending payment off ("it never went out"): no more waiting on it. Its replacement, if the same
 * payment is made again, spends one of its inputs, so the two can never both confirm (an entry from before the signed
 * tx was kept has none to share: the owner's word is all there is).
 */
export const bizWriteOffPending = (ticker: string, txid: string, s: KV | null = kv(), now = Date.now()) => {
  const t = normTicker(ticker);
  const p = getBizPending(t, s).find((x) => x.txid === txid);
  if (p) writeOff(t, p, 'written off by you', now, s);
};

const P2PKH_ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;

const dataScript = (hexParts: string[]) =>
  new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    ...hexParts.map((h) => {
      const data = Utils.toArray(h, 'hex');
      if (data.length > 75) throw new Error('Data too long');
      return { op: data.length, data };
    }),
  ]);

export const usdOf = (sats: number, usdPerBsv: number) => (sats / 1e8) * usdPerBsv;

const paymentKey = (p: BizPayment) => `${p.address}:${p.sats}:${(p.data ?? []).join(',')}`;

const TIMED_OUT = 'The network took too long to answer';
const within = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

/** Within this tab: one payment per room at a time (the fallback where navigator.locks is missing). */
const tabChains = new Map<string, Promise<unknown>>();
const tabLock: BizLock = (name, fn) => {
  const run = (tabChains.get(name) ?? Promise.resolve()).then(fn, fn);
  tabChains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
};
const defaultLock = (): BizLock => {
  const locks = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator?.locks as
    | { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> }
    | undefined;
  return typeof locks?.request === 'function' ? (name, fn) => locks.request(name, fn) : tabLock;
};

/** Plain words for a payment that is out but not confirmed. */
const waitingReason = (p: BizPending) =>
  p.rawTx
    ? `An earlier payment from this agent account (${p.detail}, ${p.txid.slice(0, 8)}…) hasn’t shown up on the ` +
      'network yet. No new payment until it does. Try again in a few minutes.'
    : `An earlier payment from this agent account (${p.detail}, ${p.txid.slice(0, 8)}…) can’t be checked: this ` +
      'device didn’t keep it. No new payment until it shows up on the network, or until you write it off in the agent ' +
      'account if you are sure it never went out.';

/** Pay from the room's agent account, inside the cap. Refused payments are logged with the reason. */
export async function bizAgentPay(p: BizPayment, d: BizPayDeps): Promise<BizPayResult> {
  const s = d.store === undefined ? kv() : d.store;
  const now = d.now ?? Date.now;
  const stopAll = d.stopAll ?? allAgentsStopped;
  const t = normTicker(p.ticker);
  const refuse = (reason: string): BizPayResult => {
    appendLog(t, { at: now(), action: 'refused', detail: `${p.detail}: ${reason}`, usd: 0 }, s);
    return { ok: false, reason };
  };
  if (!Number.isInteger(p.sats) || p.sats < 1) return refuse('Bad amount');
  if (!P2PKH_ADDR.test(p.address)) return refuse('Bad address');
  if (!(d.usdPerBsv > 0)) return refuse('No BSV price, so the limit cannot be checked');
  const usd = usdOf(p.sats, d.usdPerBsv);
  const ms = d.broadcastTimeoutMs ?? BIZ_BROADCAST_TIMEOUT_MS;
  const key = paymentKey(p);
  /** Pending payments not in the log (it is trimmed) still count toward the cap. */
  const gate = () => {
    const log = getBizLog(t, s);
    const inLog = new Set(log.map((e) => e.txid));
    const extra: BizLogEntry[] = getBizPending(t, s)
      .filter((x) => !inLog.has(x.txid))
      .map((x) => ({ at: x.at, action: 'pending', detail: x.detail, usd: x.usd }));
    return bizSpendAllowed(getBizAgent(t, s), stopAll(), [...log, ...extra], usd, now());
  };
  /** Waiting on an earlier payment: said once in the log per payment (repeated taps update that one line). */
  const waiting = (x: BizPending): BizPayResult => {
    const reason = waitingReason(x);
    upsertLog(t, { at: now(), action: 'refused', detail: `${p.detail}: ${reason}`, usd: 0, id: `wait:${x.txid}` }, s);
    return { ok: false, reason, ...(x.key === key ? { pending: true as const, txid: x.txid } : {}) };
  };
  /** Same payment already out, or a payment still unsure: what this tap gets instead of a new signature. */
  const settled = (): BizPayResult | undefined => {
    const done = doneFor(t, key, s);
    if (done) return { ok: true, txid: done.txid, usd: done.usd };
    const open = getBizPending(t, s);
    const mine = open.find((x) => x.key === key);
    if (mine || open.length) return waiting(mine ?? open[0]);
    return undefined;
  };

  return (d.lock ?? defaultLock())(`bwalletx-biz-agent:${t}`, async (): Promise<BizPayResult> => {
    try {
      // Earlier payments still unsure: where they stand, before anything new is signed.
      for (const x of getBizPending(t, s)) {
        const st = await within((d.txStatus ?? (async () => 'unknown' as const))(x.txid), ms).catch(
          (): BizTxStatus => 'unknown',
        );
        if (st === 'seen') {
          markPaid(t, x, now(), s);
          continue;
        }
        if (st === 'rejected') {
          writeOff(t, x, 'refused by the network (invalid)', now(), s);
          continue;
        }
        // Not seen, not provably invalid: post the SAME signed tx again (same txid, can never pay twice).
        if (!x.rawTx) return waiting(x);
        const out = await within(d.broadcast(x.rawTx), ms).then(
          () => true,
          () => false,
        );
        if (!out) return waiting(x);
        markPaid(t, x, now(), s);
      }
      const early = settled();
      if (early) return early;

      const first = gate();
      if (!first.ok) return refuse(first.reason);
      const a = getBizAgent(t, s)!;
      const priv = await deriveBizAgentKey(d.wallet, t);
      if (priv.toAddress() !== a.address) return refuse('Agent key does not match this wallet');
      const coins = (await within(d.findCoins(a.address), ms)).filter((c) => c.sats > 1);
      // The same payment written off before: this one must spend one of its inputs, so at most one can ever confirm. If
      // none of them is unspent any more, the old tx (or a tx spending its coins) went out: it counts as paid.
      const wo = writtenOffFor(t, key, s);
      const must = new Set(wo?.inputs ?? []);
      const shared = coins.filter((c) => must.has(`${c.txid}.${c.vout}`));
      if (wo && must.size && !shared.length) {
        const old: BizPending = { txid: wo.txid, key, usd, detail: p.detail, at: wo.at };
        markPaid(t, old, now(), s);
        setWrittenOff(t, key, undefined, s);
        return { ok: true, txid: wo.txid, usd };
      }

      const tx = new Transaction();
      tx.addOutput({ lockingScript: new P2PKH().lock(p.address), satoshis: p.sats });
      if (p.data?.length) tx.addOutput({ lockingScript: dataScript(p.data), satoshis: 0 });
      tx.addOutput({ lockingScript: new P2PKH().lock(a.address), change: true });
      let added = 0;
      const rest = coins.filter((c) => !shared.includes(c)).sort((x, y) => y.sats - x.sats);
      for (const c of [...shared, ...rest]) {
        if (added >= p.sats + 1000 && !shared.includes(c)) break;
        tx.addInput({
          sourceTransaction: c.sourceTx,
          sourceOutputIndex: c.vout,
          unlockingScriptTemplate: new P2PKH().unlock(priv),
        });
        added += c.sats;
      }
      if (added < p.sats + 50) return refuse('Not enough in the agent account');
      await tx.fee(new SatoshisPerKilobyte(FEE_SATS_PER_KB));

      // The last gate, inside the lock: Stop / cap again (a Stop pressed while coins were fetched wins), and once more no
      // pending payment and no earlier payment of this same key (another tab may have just recorded one).
      const again = settled();
      if (again) return again;
      const last = gate();
      if (!last.ok) return refuse(last.reason);
      await tx.sign();
      const txid = tx.id('hex') as string;
      const rawTx = tx.toHex();
      const pending: BizPending = { txid, key, usd, detail: p.detail, at: now(), rawTx, inputs: inputsOf(rawTx) };
      // Recorded before broadcast, with the signed tx: on the cap even if the app dies here, and only this tx is ever
      // posted for it. The write-off it replaces is carried by its shared input from here on.
      putPending(t, pending, s);
      if (wo) setWrittenOff(t, key, undefined, s);
      appendLog(t, { at: now(), action: 'pending', detail: p.detail, usd, txid, id: txid, key }, s);
      try {
        await within(d.broadcast(rawTx), ms);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // Any error or a timeout is unsure: the tx may have reached the network. It stays pending (on the cap), and the
        // next tap checks it before anything new is signed.
        console.warn(`[bizAgent] payment ${txid} unsure after broadcast: ${why}`);
        return {
          ok: false,
          pending: true,
          txid,
          reason:
            'Sent, but the network hasn’t confirmed it yet. No new payment from this agent account until it does; ' +
            'tap again in a few minutes to check.',
        };
      }
      markPaid(t, pending, now(), s);
      return { ok: true, txid, usd };
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
  });
}

const BRC29_PROTOCOL = '3241645161d8';

/**
 * The owner takes the agent account's coins back into the wallet (a BRC-29 payment to the wallet's identity,
 * then internalizeAction). The owner's own action, so it works while stopped; it never pays anyone else.
 */
export async function bizAgentSweep(
  ticker: string,
  d: {
    wallet: Pick<WalletInterface, 'createHmac' | 'getPublicKey' | 'internalizeAction'>;
    findCoins: (address: string) => Promise<BizCoin[]>;
    store?: KV | null;
    now?: () => number;
  },
): Promise<{ sats: number; txid: string | null }> {
  const s = d.store === undefined ? kv() : d.store;
  const t = normTicker(ticker);
  const a = getBizAgent(t, s);
  if (!a) throw new Error('No agent account for this room');
  const key = await deriveBizAgentKey(d.wallet, t);
  if (key.toAddress() !== a.address) throw new Error('Agent key does not match this wallet');
  const coins = (await d.findCoins(a.address)).filter((c) => c.sats > 1);
  if (!coins.length) return { sats: 0, txid: null };
  const identityKey = (await d.wallet.getPublicKey({ identityKey: true })).publicKey;
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Utils.toArray('sweep', 'utf8'));
  const to = PublicKey.fromString(identityKey).deriveChild(
    key,
    `2-${BRC29_PROTOCOL}-${derivationPrefix} ${derivationSuffix}`,
  );
  const tx = new Transaction();
  for (const c of coins)
    tx.addInput({
      sourceTransaction: c.sourceTx,
      sourceOutputIndex: c.vout,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
  tx.addOutput({ lockingScript: new P2PKH().lock(to.toAddress()), change: true });
  await tx.fee(new SatoshisPerKilobyte(FEE_SATS_PER_KB));
  await tx.sign();
  const sats = tx.outputs[0].satoshis ?? 0;
  if (sats < 1) return { sats: 0, txid: null };
  await d.wallet.internalizeAction({
    tx: tx.toAtomicBEEF(),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: key.toPublicKey().toString() },
      },
    ],
    description: `Agent account $${t} returned`,
    labels: ['bwalletx-biz-agent'],
  });
  const txid = tx.id('hex') as string;
  appendLog(
    t,
    { at: (d.now ?? Date.now)(), action: 'sweep', detail: `Returned ${sats} sats to your wallet`, usd: 0, txid },
    s,
  );
  return { sats, txid };
}

/** Coins of an address from the 1Sat indexer (same source as pots/potSend.ts). */
export const defaultFindBizCoins = async (address: string): Promise<BizCoin[]> => {
  const { OneSatServices } = await import('@1sat/wallet-browser');
  const svc = new OneSatServices('main');
  for await (const ev of svc.owner.getTxos(address, { refresh: true, limit: 1 })) {
    if (ev.type === 'done' || ev.type === 'error') break;
  }
  const utxos = (await svc.txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
  const out: BizCoin[] = [];
  for (const u of utxos) {
    const [txid, vout] = u.outpoint.split(/[._]/);
    if (!txid || !(u.satoshis && u.satoshis > 1)) continue;
    const beef = await svc.beef.getBeef(txid);
    out.push({
      txid,
      vout: parseInt(vout, 10),
      sats: u.satoshis,
      sourceTx: Transaction.fromBEEF(Array.from(beef), txid),
    });
  }
  return out;
};

/** Where a txid stands, from 1sat-stack's status passthrough (the endpoint broadcastRaw posts to). */
export const defaultBizTxStatus = async (txid: string): Promise<BizTxStatus> => {
  const { OneSatServices } = await import('@1sat/wallet-browser');
  return bizStatusOf((await new OneSatServices('main').getStackStatus(txid))?.txStatus ?? null);
};

/** The network's status word for a tx (null: never heard of it) as BizTxStatus. */
export const bizStatusOf = (txStatus: string | null): BizTxStatus => {
  if (txStatus === null) return 'missing';
  if (['MINED', 'IMMUTABLE', 'SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK'].includes(txStatus))
    return 'seen';
  // Only a tx that can never be valid is final. REJECTED (one node's policy) and DOUBLE_SPEND_ATTEMPTED (a conflict
  // that may still lose) are not: the payment stays pending and the same tx is posted again.
  if (['INVALID', 'MALFORMED'].includes(txStatus)) return 'rejected';
  return 'unknown';
};

/** Balance in sats of the agent account. */
export const bizAgentBalance = async (address: string, find = defaultFindBizCoins) =>
  (await find(address)).reduce((sum, c) => sum + c.sats, 0);
