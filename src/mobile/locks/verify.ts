/**
 * Verify a lock transaction (and its receipt, if it has one) against the chain.
 *
 * checkLockTx is pure: given the raw transaction, which of its outputs are spent and the current
 * height, it lists every lock output (decoded from the script itself, so the height and amount are what
 * the chain enforces), compares them with the receipt's claims, and reports the live status.
 * verifyLockTx does the fetching (WhatsOnChain) and is shared by the app and bwalletx.com/lock/verify.
 */
import { Lock } from '@1sat/templates';
import { Transaction } from '@bsv/sdk';
import { parseReceipt, type Receipt } from './receipt';

export type VerifiedLock = { vout: number; height: number; sats: number; address: string; spent: boolean; matured: boolean };
export type VerifyStatus = 'Locked' | 'Partly claimed' | 'Fully claimed' | 'No locks';
export type VerifyResult = {
  txid: string;
  locks: VerifiedLock[];
  totalSats: number;
  receipt: Receipt | null;
  /** True only when a receipt exists and every claim in it matches the lock outputs. */
  receiptValid: boolean;
  problems: string[];
  status: VerifyStatus;
};

export function checkLockTx(rawHex: string, spent: Set<number>, height: number): VerifyResult {
  const tx = Transaction.fromHex(rawHex);
  const txid = tx.id('hex');
  const locks: VerifiedLock[] = [];
  let receipt: Receipt | null = null;
  tx.outputs.forEach((o, vout) => {
    const d = Lock.decode(o.lockingScript);
    if (d && (o.satoshis ?? 0) > 0) {
      locks.push({ vout, height: d.until, sats: o.satoshis ?? 0, address: d.address, spent: spent.has(vout), matured: d.until <= height });
      return;
    }
    receipt ??= parseReceipt(o.lockingScript);
  });
  const problems: string[] = [];
  const r = receipt as Receipt | null;
  if (r) {
    const byVout = new Map(locks.map((l) => [l.vout, l]));
    for (const s of r.schedule) {
      const l = byVout.get(s.vout);
      if (!l) problems.push(`Output ${s.vout} is not a lock.`);
      else {
        if (l.height !== s.height) problems.push(`Output ${s.vout} unlocks at block ${l.height}, not ${s.height}.`);
        if (l.sats !== s.sats) problems.push(`Output ${s.vout} holds ${l.sats} sats, not ${s.sats}.`);
        if (l.address !== r.lockAddress) problems.push(`Output ${s.vout} is locked to a different key.`);
      }
    }
    if (r.schedule.length !== locks.length) problems.push(`The receipt lists ${r.schedule.length} locks; the transaction has ${locks.length}.`);
    const sum = r.schedule.reduce((a, s) => a + s.sats, 0);
    if (sum !== r.amountSats) problems.push('The receipt total does not add up.');
  }
  const spentN = locks.filter((l) => l.spent).length;
  const status: VerifyStatus =
    locks.length === 0 ? 'No locks' : spentN === 0 ? 'Locked' : spentN === locks.length ? 'Fully claimed' : 'Partly claimed';
  return {
    txid,
    locks,
    totalSats: locks.reduce((a, l) => a + l.sats, 0),
    receipt: r,
    receiptValid: !!r && problems.length === 0,
    problems,
    status,
  };
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** Fetch the tx, the spent state of its lock outputs and the height, then check. */
export async function verifyLockTx(txid: string, f: typeof fetch = fetch): Promise<VerifyResult> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('That is not a transaction id.');
  const hexRes = await f(`${WOC}/tx/${txid}/hex`);
  if (!hexRes.ok) throw new Error('Transaction not found.');
  const hex = (await hexRes.text()).trim();
  const info = await f(`${WOC}/chain/info`).then((r) => r.json() as Promise<{ blocks: number }>);
  const first = checkLockTx(hex, new Set(), info.blocks);
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
