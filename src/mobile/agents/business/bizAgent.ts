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
 * A broadcast that errs or times out is unsure, never 'failed' (task 72 review, B1): the tx may have reached the network
 * (a refund that timed out but landed, then a second tap, refunded twice). The entry stays 'pending' with its signed tx,
 * and no new payment is signed for that room until its txid is seen on chain (then 'paid'; the same payment tapped again
 * gets that txid back) or the network refuses it.
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
  /** A 'pending' entry: the signed tx (public once broadcast), so the same tx can be posted again, never a new one. */
  rawTx?: string;
  /** What was paid (to, sats, data): a tap for the same payment finds its earlier tx instead of paying again. */
  key?: string;
  /** A 'paid' entry settled by a later check: the same payment's next tap gets its txid back (once). */
  late?: boolean;
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

/** Where a txid stands: 'seen' (on the network or mined), 'rejected' (refused), 'missing' (never heard of), 'unknown'. */
export type BizTxStatus = 'seen' | 'rejected' | 'missing' | 'unknown';

/** The longest a broadcast or a status check is waited for: past it, the payment is unsure (kept pending). */
export const BIZ_BROADCAST_TIMEOUT_MS = 30_000;

export type BizPayDeps = {
  wallet: Pick<WalletInterface, 'createHmac'>;
  /** Unspent coins of an address with their source txs. */
  findCoins: (address: string) => Promise<BizCoin[]>;
  broadcast: (rawTx: string) => Promise<void>;
  /** Where an earlier payment's txid stands (defaultBizTxStatus). Absent: 'unknown' (a pending payment keeps waiting). */
  txStatus?: (txid: string) => Promise<BizTxStatus>;
  /** Bound on one broadcast or status check (default BIZ_BROADCAST_TIMEOUT_MS). */
  broadcastTimeoutMs?: number;
  /** USD per BSV now; the cap is checked on sats × rate (never on a figure the server sent). */
  usdPerBsv: number;
  stopAll?: () => boolean;
  store?: KV | null;
  now?: () => number;
};

export type BizPayment = { ticker: string; address: string; sats: number; data?: string[]; detail: string };
export type BizPayResult =
  | { ok: true; txid: string; usd: number }
  /** pending: signed and posted, outcome unknown; nothing new is paid from this room until it settles. */
  | { ok: false; reason: string; pending?: true; txid?: string };

const P2PKH_ADDR = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const inFlight = new Set<string>();

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

/** Plain words for a payment that is out but not confirmed. */
const waitingReason = (e: BizLogEntry) =>
  `An earlier payment from this agent account (${e.detail}, ${String(e.txid).slice(0, 8)}…) hasn’t shown up on the ` +
  'network yet. No new payment until it does or the network refuses it. Try again in a few minutes.';

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
  const gate = () => bizSpendAllowed(getBizAgent(t, s), stopAll(), getBizLog(t, s), usd, now());

  const ms = d.broadcastTimeoutMs ?? BIZ_BROADCAST_TIMEOUT_MS;
  const key = paymentKey(p);

  if (inFlight.has(t)) return refuse('Another agent payment is in progress');
  inFlight.add(t);
  try {
    // An earlier payment settled late, tapped again: its txid, never a second payment.
    const late = getBizLog(t, s).find((e) => e.action === 'paid' && e.late && e.key === key && e.txid);
    if (late?.id) {
      replaceLog(t, late.id, { ...late, late: undefined }, s);
      return { ok: true, txid: late.txid!, usd: late.usd };
    }
    // A payment still unsure (its broadcast erred or timed out): find out where it stands before anything new is signed.
    for (const e of getBizLog(t, s).filter((x) => x.action === 'pending' && x.txid && x.id)) {
      const st = await within((d.txStatus ?? (async () => 'unknown' as const))(e.txid!), ms).catch(
        (): BizTxStatus => 'unknown',
      );
      let out: 'paid' | 'failed' | 'waiting' = st === 'seen' ? 'paid' : st === 'rejected' ? 'failed' : 'waiting';
      if (st === 'missing') {
        if (e.rawTx) {
          // The network never heard of it: post the SAME signed tx again (same txid; idempotent, can't pay twice).
          out = await within(d.broadcast(e.rawTx), ms).then(
            () => 'paid' as const,
            () => 'waiting' as const,
          );
        } else out = 'failed'; // an entry from before the signed tx was kept: nobody holds it, it can't go out now
      }
      if (out === 'waiting') return refuse(waitingReason(e));
      const { rawTx: _raw, ...rest } = e;
      if (out === 'failed') {
        replaceLog(t, e.id!, { ...rest, action: 'failed', detail: `${e.detail}: refused by the network` }, s);
        continue;
      }
      const same = e.key === key;
      replaceLog(t, e.id!, { ...rest, action: 'paid', ...(same ? {} : { late: true }) }, s);
      if (same) return { ok: true, txid: e.txid!, usd: e.usd };
    }

    const first = gate();
    if (!first.ok) return refuse(first.reason);
    const a = getBizAgent(t, s)!;
    const priv = await deriveBizAgentKey(d.wallet, t);
    if (priv.toAddress() !== a.address) return refuse('Agent key does not match this wallet');
    const coins = (await d.findCoins(a.address)).filter((c) => c.sats > 1);

    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(p.address), satoshis: p.sats });
    if (p.data?.length) tx.addOutput({ lockingScript: dataScript(p.data), satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(a.address), change: true });
    let added = 0;
    for (const c of coins.sort((x, y) => y.sats - x.sats)) {
      tx.addInput({
        sourceTransaction: c.sourceTx,
        sourceOutputIndex: c.vout,
        unlockingScriptTemplate: new P2PKH().unlock(priv),
      });
      added += c.sats;
      if (added >= p.sats + 1000) break;
    }
    if (added < p.sats + 50) return refuse('Not enough in the agent account');
    await tx.fee(new SatoshisPerKilobyte(FEE_SATS_PER_KB));

    // Stop / cap again, right before signing: a Stop pressed while coins were fetched wins.
    const last = gate();
    if (!last.ok) return refuse(last.reason);
    await tx.sign();
    const txid = tx.id('hex') as string;
    const id = txid;
    const rawTx = tx.toHex();
    // Booked before broadcast, with the signed tx: counts toward the cap even if the app dies here, and only this tx is
    // ever posted for it.
    appendLog(t, { at: now(), action: 'pending', detail: p.detail, usd, txid, id, rawTx, key }, s);
    try {
      await within(d.broadcast(rawTx), ms);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // Any error or a timeout is unsure: the tx may have reached the network. It stays pending (on the cap), and the
      // next tap checks it on chain before anything new is signed.
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
    replaceLog(t, id, { at: now(), action: 'paid', detail: p.detail, usd, txid, id, key }, s);
    return { ok: true, txid, usd };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  } finally {
    inFlight.delete(t);
  }
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
  const r = await new OneSatServices('main').getStackStatus(txid);
  if (!r) return 'missing';
  if (['MINED', 'IMMUTABLE', 'SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK'].includes(r.txStatus))
    return 'seen';
  if (['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'INVALID', 'MALFORMED'].includes(r.txStatus)) return 'rejected';
  return 'unknown';
};

/** Balance in sats of the agent account. */
export const bizAgentBalance = async (address: string, find = defaultFindBizCoins) =>
  (await find(address)).reduce((sum, c) => sum + c.sats, 0);
