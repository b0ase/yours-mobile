/**
 * Verify a lock transaction (and its receipt, if it has one) against the chain.
 *
 * checkLockTx is pure: given the raw transaction, which of its outputs are spent and the current
 * height, it lists every lock output (decoded from the script itself, so the height and amount are what
 * the chain enforces), compares them with the receipt's claims, and reports the live status. An output
 * counts as a lock only when its script is exactly the lock (tokenLocks.exactLock); one that merely
 * contains the lock pattern is reported as a problem and never shown as locked.
 * verifyLockTx does the fetching (WhatsOnChain) and is shared by the app and bwalletx.com/lock/verify.
 */
import { Lock } from '@1sat/templates';
import { Transaction } from '@bsv/sdk';
import { describeReceipt, parseReceipt, type Receipt } from './receipt';
import { exactLock } from './tokenLocks';

export type VerifiedLock = {
  vout: number;
  height: number;
  sats: number;
  address: string;
  spent: boolean;
  matured: boolean;
  /** A BSV-21 token lock: the token id and amount (base units) the script carries. */
  token?: { id: string; amt: string };
};
export type VerifyStatus = 'Locked' | 'Partly claimed' | 'Fully claimed' | 'No locks';
export type VerifyResult = {
  txid: string;
  locks: VerifiedLock[];
  totalSats: number;
  receipt: Receipt | null;
  /** True only when a receipt exists and every claim in it matches the lock outputs. */
  receiptValid: boolean;
  /** What the receipt says the schedule is ("Dollar target … · curve: back-loaded ×2"), if there is one. */
  description: string | null;
  problems: string[];
  status: VerifyStatus;
};

export function checkLockTx(rawHex: string, spent: Set<number>, height: number): VerifyResult {
  const tx = Transaction.fromHex(rawHex);
  const txid = tx.id('hex');
  const locks: VerifiedLock[] = [];
  const problems: string[] = [];
  let receipt: Receipt | null = null;
  tx.outputs.forEach((o, vout) => {
    if (Lock.isLock(o.lockingScript)) {
      // Only the exact lock script counts (lockFinder's rule; a token lock may carry its BSV-21 envelope in front).
      // The lock pattern with anything else around it may be spendable now: never listed, never read as a receipt.
      const d = exactLock(o.lockingScript);
      if (!d) problems.push(`Output ${vout} is not a valid lock, so it is not counted as locked.`);
      else if ((o.satoshis ?? 0) > 0)
        locks.push({
          ...(d.token ? { token: { id: d.token.id, amt: String(d.token.amt) } } : {}),
          vout,
          height: d.until,
          sats: o.satoshis ?? 0,
          address: d.address,
          spent: spent.has(vout),
          matured: d.until <= height,
        });
      return;
    }
    receipt ??= parseReceipt(o.lockingScript);
  });
  const r = receipt as Receipt | null;
  if (r) {
    const byVout = new Map(locks.map((l) => [l.vout, l]));
    // Each entry must name a different output with whole, non-negative numbers: a repeated vout would let one lock
    // stand for two and hide another lock (someone else's, or one already open) behind the receipt.
    const listed = new Set<number>();
    const whole = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
    for (const s of r.schedule) {
      if (!s || typeof s !== 'object' || !whole(s.vout) || !whole(s.height) || !whole(s.sats)) {
        problems.push('The receipt has an entry that is not a whole output, block and amount.');
        continue;
      }
      if (listed.has(s.vout)) {
        problems.push(`The receipt lists output ${s.vout} twice.`);
        continue;
      }
      listed.add(s.vout);
      const l = byVout.get(s.vout);
      if (!l) problems.push(`Output ${s.vout} is not a lock.`);
      else {
        if (l.height !== s.height) problems.push(`Output ${s.vout} unlocks at block ${l.height}, not ${s.height}.`);
        if (l.sats !== s.sats) problems.push(`Output ${s.vout} holds ${l.sats} sats, not ${s.sats}.`);
        if (l.address !== r.lockAddress) problems.push(`Output ${s.vout} is locked to a different key.`);
        if (r.token) {
          if (!l.token) problems.push(`Output ${s.vout} holds no tokens.`);
          else {
            if (l.token.id !== r.token.id) problems.push(`Output ${s.vout} holds a different token.`);
            if (l.token.amt !== r.token.amt)
              problems.push(`Output ${s.vout} holds ${l.token.amt} token units, not ${r.token.amt}.`);
          }
        } else if (l.token) problems.push(`Output ${s.vout} is a token lock, but the receipt is for BSV.`);
      }
    }
    for (const l of locks)
      if (!listed.has(l.vout)) problems.push(`Output ${l.vout} is a lock the receipt does not list.`);
    if (r.schedule.length !== locks.length)
      problems.push(`The receipt lists ${r.schedule.length} locks; the transaction has ${locks.length}.`);
    const sum = r.schedule.reduce((a, s) => a + (s && whole(s.sats) ? s.sats : NaN), 0);
    if (sum !== r.amountSats) problems.push('The receipt total does not add up.');
  }
  // A receipt only vouches for locks: one that lists none must not show green next to its own token amount.
  if (r && locks.length === 0) problems.push('The receipt names no lock in this transaction.');
  const spentN = locks.filter((l) => l.spent).length;
  const status: VerifyStatus =
    locks.length === 0
      ? 'No locks'
      : spentN === 0
        ? 'Locked'
        : spentN === locks.length
          ? 'Fully claimed'
          : 'Partly claimed';
  return {
    txid,
    locks,
    totalSats: locks.reduce((a, l) => a + l.sats, 0),
    receipt: r,
    receiptValid: !!r && problems.length === 0,
    description: r ? describeReceipt(r) : null,
    problems,
    status,
  };
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** WhatsOnChain rate-limits (429, which a browser also reports as a CORS failure): retry with backoff. */
async function retrying(f: typeof fetch, url: string, init?: RequestInit, tries = 4): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await f(url, init);
      if (r.status !== 429 || i >= tries - 1) return r;
    } catch (e) {
      if (i >= tries - 1) throw e;
    }
    await new Promise((res) => setTimeout(res, 800 * 2 ** i));
  }
}

/** Fetch the tx, the spent state of its lock outputs and the height, then check. */
export async function verifyLockTx(txid: string, fetcher: typeof fetch = fetch): Promise<VerifyResult> {
  const f = ((url: string, init?: RequestInit) => retrying(fetcher, url, init)) as typeof fetch;
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('That is not a transaction id.');
  const hexRes = await f(`${WOC}/tx/${txid}/hex`);
  if (!hexRes.ok) throw new Error('Transaction not found.');
  const hex = (await hexRes.text()).trim();
  const info = await f(`${WOC}/chain/info`).then((r) => r.json() as Promise<{ blocks: number }>);
  const first = checkLockTx(hex, new Set(), info.blocks);
  if (first.txid !== txid.toLowerCase()) throw new Error('The transaction does not match its id.');
  const spent = new Set<number>();
  // WhatsOnChain's bulk spent lookup: an entry with spentIn means the output has been spent.
  for (let i = 0; i < first.locks.length; i += 20) {
    const utxos = first.locks.slice(i, i + 20).map((l) => ({ txid, vout: l.vout }));
    const res = await f(`${WOC}/utxos/spent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utxos }),
    });
    if (!res.ok) throw new Error('Could not read spent status.');
    const rows = (await res.json()) as { utxo: { vout: number }; spentIn?: unknown }[];
    for (const row of rows) if (row.spentIn) spent.add(row.utxo.vout);
  }
  return checkLockTx(hex, spent, info.blocks);
}
