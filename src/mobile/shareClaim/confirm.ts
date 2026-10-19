import { Transaction } from '@bsv/sdk';
import { buildShareLock, matchesShareLock } from './lockScript';
import type { CheckedInvite } from './invite';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

export type LockedTranche = { tranche: string; tokenId: string; amount: number; outpoint: string };

/**
 * Checks a lock transaction the company reports: for EVERY tranche in the invite there must be an output whose
 * script is exactly buildShareLock(tranche token, amount, holder lockPubKey, PINNED company lock key). Only then
 * does the wallet show "done". Each output is used once.
 */
export function checkLockTx(tx: Transaction, inv: CheckedInvite, lockPubKey: string): LockedTranche[] {
  const txid = tx.id('hex');
  const used = new Set<number>();
  return inv.tokens.map((t) => {
    const p = { tokenId: t.id, amount: t.amount, holderPubKey: lockPubKey, companyPubKey: inv.pin.lockKey };
    const want = buildShareLock(p).toHex();
    const i = tx.outputs.findIndex(
      (o, j) => !used.has(j) && o.lockingScript.toHex() === want && matchesShareLock(o.lockingScript, p),
    );
    if (i < 0) throw new Error(`Tranche ${t.tranche}: no matching locked output in ${txid}`);
    used.add(i);
    return { tranche: t.tranche, tokenId: t.id, amount: t.amount, outpoint: `${txid}_${i}` };
  });
}

/** Fetches the tx from the chain (WhatsOnChain), checks its id, then checkLockTx. */
export async function confirmLock(
  txid: string,
  inv: CheckedInvite,
  lockPubKey: string,
  f: typeof fetch = fetch,
): Promise<LockedTranche[]> {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Bad txid');
  const r = await f(`${WOC}/tx/${txid}/hex`);
  if (!r.ok) throw new Error('The lock transaction is not on chain yet');
  const tx = Transaction.fromHex((await r.text()).trim());
  if (tx.id('hex') !== txid) throw new Error('The chain returned a different transaction');
  return checkLockTx(tx, inv, lockPubKey);
}
