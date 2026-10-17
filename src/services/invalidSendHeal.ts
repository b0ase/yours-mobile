/**
 * A send the network rejects as invalid, retried with the same dead coins every time: clear the ones already spent.
 *
 * Owner's NPG account, 17 Oct 2026: every $1 send came back WERR_REVIEW_ACTIONS / invalidTx. The account's BSV was
 * also spent outside this wallet (a 1Sat sweep of the same keys paid its fees), but storage still listed those
 * outputs as spendable. The toolbox fails a rejected action and releases its inputs, so the next send picks the
 * same outputs and is rejected again, forever.
 *
 * Here, after an invalidTx, each input of the rejected transaction (WERR_REVIEW_ACTIONS carries it as AtomicBEEF) is
 * checked: one the broadcaster names as spent (UTXO_SPENT) is taken as is; the rest are looked up on the 1sat spend
 * index, then WhatsOnChain (confirmed or mempool). Only inputs with a named spending txid are marked spendable: false.
 * A lookup that fails, or any answer without a spending txid, leaves that input alone (fail closed): this must never
 * hide live money. Second test of the same day: "UTXO_SPENT (70)" from the broadcaster while the 1sat index named no
 * spender (spent from another device holding the same keys, likely still unconfirmed).
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
 * The inputs proven spent. Each input stands alone: a lookup that throws, or an answer without a spending txid,
 * leaves that input as it is (fail closed per input). `getSpend` resolves the spending txid, or null/undefined while
 * unspent, and throws when it can't tell; `fallback` (e.g. WhatsOnChain, which also sees the mempool) is asked when
 * the first lookup can't name a spender.
 */
export async function provenSpent(
  outpoints: string[],
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  fallback?: (outpoint: string) => Promise<string | null | undefined>,
  rejectedTxid?: string,
): Promise<string[]> {
  const spent: string[] = [];
  const ask = async (f: typeof getSpend, op: string) => {
    try {
      const by = await f(op);
      // The rejected tx itself is not a spender (it never went out).
      return typeof by === 'string' && TXID.test(by) && by !== rejectedTxid ? by : null;
    } catch {
      return null;
    }
  };
  for (const op of outpoints) {
    if ((await ask(getSpend, op)) || (fallback && (await ask(fallback, op)))) spent.push(op);
  }
  return spent;
}

/**
 * Pure: inputs the broadcaster itself names as spent. ARC/Teranode reports e.g.
 * "UTXO_SPENT (70): [ProcessTransaction][<txid of the tx being processed>] …"; an input outpoint written in the
 * reason ("txid:vout" or "txid_vout") after a UTXO_SPENT verdict is taken as authoritative.
 */
export function namedSpentInputs(reason: string | undefined, inputs: string[]): string[] {
  if (!reason || !/UTXO_SPENT|already spent|missing ?inputs/i.test(reason)) return [];
  const text = reason.toLowerCase();
  return inputs.filter((op) => {
    const [txid, vout] = op.split('_');
    return text.includes(`${txid}:${vout}`) || text.includes(`${txid}_${vout}`);
  });
}

export interface HealStore {
  /** Mark this outpoint's output spendable: false for the account; resolves how many rows changed. */
  markSpent: (txid: string, vout: number) => Promise<number>;
}

export type HealReport = { checked: number; released: number; inputs?: string[] };

/** After an invalidTx: release the rejected send's inputs proven spent. Never throws. */
export async function healInvalidSend(
  error: unknown,
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  store: HealStore,
  opts: { fallback?: (outpoint: string) => Promise<string | null | undefined>; reason?: string } = {},
): Promise<HealReport> {
  if (!isInvalidTxReview(error)) return { checked: 0, released: 0 };
  const inputs = rejectedInputs(error);
  const rejectedTxid = (error as ReviewError).reviewActionResults?.find((r) => r?.status === 'invalidTx')?.txid;
  const named = namedSpentInputs(opts.reason, inputs);
  const looked = await provenSpent(
    inputs.filter((op) => !named.includes(op)),
    getSpend,
    opts.fallback,
    rejectedTxid,
  );
  let released = 0;
  for (const op of [...named, ...looked]) {
    const [txid, vout] = op.split('_');
    released += await store.markSpent(txid, Number(vout)).catch(() => 0);
  }
  return { checked: inputs.length, released, inputs };
}

/** What to add to the error the person sees. With nothing cleared, name the coins tried so a report can be traced. */
export const healMessage = (r: HealReport): string =>
  r.released > 0
    ? ` ${r.released === 1 ? '1 coin was' : `${r.released} coins were`} already spent elsewhere (another device?); cleared — tap Send again.`
    : r.inputs?.length
      ? ` Coins tried: ${r.inputs
          .slice(0, 4)
          .map((o) => `${o.slice(0, 10)}…:${o.split('_')[1]}`)
          .join(', ')}${r.inputs.length > 4 ? ` +${r.inputs.length - 4}` : ''}.`
      : '';
