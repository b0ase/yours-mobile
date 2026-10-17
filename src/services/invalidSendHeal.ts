/**
 * A send the network rejects as invalid, retried with the same dead coins every time: clear the ones already spent.
 *
 * Owner's NPG account, 17 Oct 2026: every $1 send came back WERR_REVIEW_ACTIONS / invalidTx. The account's BSV was
 * also spent outside this wallet (a 1Sat sweep of the same keys paid its fees), but storage still listed those
 * outputs as spendable. The toolbox fails a rejected action and releases its inputs, so the next send picks the
 * same outputs and is rejected again, forever.
 *
 * Here, after an invalidTx, each input of the rejected transaction (WERR_REVIEW_ACTIONS carries it as AtomicBEEF) is
 * looked up on the chain. Only inputs the chain names a spending txid for are marked spendable: false. A lookup that
 * fails, or any answer without a spending txid, changes nothing (fail closed): an input that is unspent but could
 * not be unlocked is a different bug, and this must never hide live money.
 *
 * Not the toolbox's reviewSpendableOutputs: OneSatServices.getUtxoStatus reports a failed lookup as "not a UTXO",
 * so a flaky API would release live coins.
 */
import { Transaction } from '@bsv/sdk';

const TXID = /^[0-9a-f]{64}$/i;

type ReviewError = Error & {
  name?: string;
  txid?: string;
  tx?: number[];
  reviewActionResults?: { txid?: string; status?: string }[];
};

/** Pure: was this a broadcast the network refused as invalid (not a double spend, not a service hiccup)? */
export const isInvalidTxReview = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as ReviewError).reviewActionResults ?? []).some((r) => r?.status === 'invalidTx');

/** Pure: the outpoints ("txid_vout") the rejected transaction spends, from the error's AtomicBEEF. */
export function rejectedInputs(error: unknown): string[] {
  const tx = (error as ReviewError)?.tx;
  if (!Array.isArray(tx) || !tx.length) return [];
  try {
    return Transaction.fromAtomicBEEF(tx)
      .inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex') ?? ''}_${i.sourceOutputIndex}`)
      .filter((o) => TXID.test(o.split('_')[0]));
  } catch {
    return [];
  }
}

/**
 * The inputs the chain says are spent, or null when any lookup failed (then nothing is released).
 * `getSpend` resolves the spending txid, or null/undefined while unspent, and throws when it can't tell.
 */
export async function provenSpent(
  outpoints: string[],
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
): Promise<string[] | null> {
  const spent: string[] = [];
  for (const op of outpoints) {
    let by: string | null | undefined;
    try {
      by = await getSpend(op);
    } catch {
      return null;
    }
    if (typeof by === 'string' && TXID.test(by)) spent.push(op);
  }
  return spent;
}

export interface HealStore {
  /** Mark this outpoint's output spendable: false for the account; resolves how many rows changed. */
  markSpent: (txid: string, vout: number) => Promise<number>;
}

export type HealReport = { checked: number; released: number; inconclusive?: boolean };

/** After an invalidTx: release the rejected send's inputs the chain proves spent. Never throws. */
export async function healInvalidSend(
  error: unknown,
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  store: HealStore,
): Promise<HealReport> {
  if (!isInvalidTxReview(error)) return { checked: 0, released: 0 };
  const inputs = rejectedInputs(error);
  const spent = await provenSpent(inputs, getSpend);
  if (!spent) return { checked: inputs.length, released: 0, inconclusive: true };
  let released = 0;
  for (const op of spent) {
    const [txid, vout] = op.split('_');
    released += await store.markSpent(txid, Number(vout)).catch(() => 0);
  }
  return { checked: inputs.length, released };
}

/** What to add to the error the person sees. */
export const healMessage = (r: HealReport): string =>
  r.released > 0
    ? ` ${r.released === 1 ? 'One coin was already spent elsewhere; it is' : `${r.released} coins were already spent elsewhere; they are`} now cleared. Please try again.`
    : '';
