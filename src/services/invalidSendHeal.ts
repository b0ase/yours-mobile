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
import { SPENT_ELSEWHERE_MESSAGE } from '../utils/sendErrors';

/** Shown when coins were cleared but the send did not go out. Plain words, no toolbox text (utils/sendErrors.ts). */
export { SPENT_ELSEWHERE_MESSAGE };

const TXID = /^[0-9a-f]{64}$/i;

type ReviewError = Error & {
  name?: string;
  txid?: string;
  tx?: number[];
  reviewActionResults?: { txid?: string; status?: string }[];
};

/**
 * WERR_REVIEW_ACTIONS statuses that mean "the network refused this send because of its inputs": REJECTED (invalidTx)
 * and DOUBLE_SPEND_ATTEMPTED (doubleSpend). In storage both fail the action and free its inputs, so both are healed
 * (owner's iPhone, 4 Nov 2026: coins spent from the extension). On the NETWORK they differ: ARC keeps a double-spend
 * attempt, which is mined if the other payment drops (the toolbox un-fails such txs: TaskReviewDoubleSpends). So after
 * a doubleSpend the send is retried only when every competing spend is mined (spentRetry.ts; review 17, F2).
 */
const REFUSED_STATUSES = new Set(['invalidTx', 'doubleSpend']);

/** Pure: the refusal's status ('invalidTx' or 'doubleSpend') and txid (lowercase) if the error names one. */
export const refusal = (error: unknown): { status: 'invalidTx' | 'doubleSpend'; txid?: string } | undefined => {
  const r = (error as ReviewError | null)?.reviewActionResults?.find((x) => REFUSED_STATUSES.has(x?.status ?? ''));
  if (!r) return undefined;
  const txid = typeof r.txid === 'string' && TXID.test(r.txid) ? r.txid.toLowerCase() : undefined;
  return { status: r.status as 'invalidTx' | 'doubleSpend', txid };
};

/** Pure: the refused transaction's txid (invalidTx or doubleSpend), lowercase, if the error names one. */
export const refusedTxid = (error: unknown): string | undefined => refusal(error)?.txid;

/** Pure: the spender the broadcaster's reason names ("… already spent by tx <txid>"), lowercase. */
export const reasonSpender = (reason: string | undefined): string | undefined =>
  /spent by (?:tx )?([0-9a-f]{64})/i.exec(reason ?? '')?.[1]?.toLowerCase();

/** Pure: was this a broadcast the network refused (invalid or a double spend), not a service hiccup? */
export const isInvalidTxReview = (error: unknown): boolean =>
  error instanceof Error &&
  ((error as ReviewError).reviewActionResults ?? []).some((r) => REFUSED_STATUSES.has(r?.status ?? ''));

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
  return Object.keys(await provenSpenders(outpoints, getSpend, fallback, rejectedTxid));
}

/** provenSpent, with each input's spending txid (lowercase). */
export async function provenSpenders(
  outpoints: string[],
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  fallback?: (outpoint: string) => Promise<string | null | undefined>,
  rejectedTxid?: string,
): Promise<Record<string, string>> {
  const spent: Record<string, string> = {};
  const ask = async (f: typeof getSpend, op: string) => {
    try {
      const by = await f(op);
      // The rejected tx itself is not a spender (it never went out).
      return typeof by === 'string' && TXID.test(by) && by.toLowerCase() !== rejectedTxid?.toLowerCase()
        ? by.toLowerCase()
        : null;
    } catch {
      return null;
    }
  };
  for (const op of outpoints) {
    const by = (await ask(getSpend, op)) || (fallback && (await ask(fallback, op)));
    if (by) spent[op] = by;
  }
  return spent;
}

/**
 * Pure: inputs the broadcaster itself names as spent. ARC/Teranode reports e.g.
 * "UTXO_SPENT (70): [ProcessTransaction][<txid of the tx being processed>] …"; an input outpoint written in the
 * reason ("txid:vout" or "txid_vout") after a UTXO_SPENT verdict is taken as authoritative.
 */
export function namedSpentInputs(reason: string | undefined, inputs: string[]): string[] {
  // Not "missing inputs": that usually means a parent the node doesn't know, not a spent coin (17b L3).
  if (!reason || !/UTXO_SPENT|already spent/i.test(reason)) return [];
  const text = reason.toLowerCase();
  return inputs.filter((op) => {
    const [txid, vout] = op.split('_');
    return text.includes(`${txid}:${vout}`) || text.includes(`${txid}_${vout}`);
  });
}

export interface HealStore {
  /** Mark this outpoint's output spendable: false for the account; resolves how many rows changed. */
  markSpent: (txid: string, vout: number) => Promise<number>;
  /**
   * Is this outpoint listed as spendable now? false = storage already holds it unspendable; null = no row, or can't
   * tell. Owner's iPhone, 3 Nov 2026 (board minute 010 seal, UTXO_SPENT on eb6dcc27…:2): after a refused broadcast
   * the toolbox's own stale-input check (markStaleInputsAsSpent) can mark the input spendable: false BEFORE this heal
   * runs, so markSpent changed 0 rows, the heal reported "nothing cleared", and the one safe retry never ran even
   * though the dead coin was already out of coin selection.
   */
  isSpendable?: (txid: string, vout: number) => Promise<boolean | null>;
}

/**
 * Clear one proven-spent outpoint. `changed`: rows this heal set unspendable now; `already`: nothing changed, but storage
 * already holds it unspendable (the toolbox's own stale-input check got there first, 3 Nov 2026). An unknown row, a
 * remote store or an unreadable answer is never `already`. Never throws.
 */
async function clearOne(store: HealStore, op: string): Promise<{ changed: number; already: boolean }> {
  const [txid, v] = op.split('_');
  const vout = Number(v);
  const changed = await store.markSpent(txid, vout).catch(() => 0);
  if (changed > 0) return { changed, already: false };
  const spendable = await Promise.resolve()
    .then(() => store.isSpendable?.(txid, vout) ?? null)
    .catch(() => null);
  return { changed: 0, already: spendable === false };
}

export type HealReport = {
  checked: number;
  released: number;
  inputs?: string[];
  /**
   * Every input proven spent → the transaction that spent it (null when the broadcaster named the input without its
   * spender). The retry decision reads these (spentRetry.ts: never retry when a spender is a payment of ours).
   */
  spenders?: Record<string, string | null>;
  /** The inputs whose rows this heal changed (spendable → false). */
  cleared?: string[];
  /**
   * Proven-spent inputs storage already held unspendable (the toolbox's stale-input check, 3 Nov 2026): counted in
   * `released` (the retry can't pick them again) but NOT in `cleared`, because this heal changed nothing there, so
   * nothing goes on the automatic check's undo list for them.
   */
  alreadyOff?: string[];
  /** Inputs set aside because their parent payment never reached the network (ownSend.ts healRefusedInputs). */
  orphaned?: string[];
};

/**
 * Settings › Troubleshooting › Resync coins (owner, 17 Oct 2026: sends kept failing with UTXO_SPENT after coins were
 * spent from another device). Checks every coin storage lists as spendable, same lookups and the same fail-closed
 * rule as healInvalidSend: a coin is cleared only when a spending txid is named. Never throws.
 */
export async function resyncSpent(
  outpoints: string[],
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  store: HealStore,
  opts: {
    fallback?: (outpoint: string) => Promise<string | null | undefined>;
    onProgress?: (done: number) => void;
  } = {},
): Promise<HealReport> {
  const spent: string[] = [];
  for (let i = 0; i < outpoints.length; i++) {
    spent.push(...(await provenSpent([outpoints[i]], getSpend, opts.fallback)));
    opts.onProgress?.(i + 1);
  }
  let released = 0;
  for (const op of spent) {
    const [txid, vout] = op.split('_');
    released += await store.markSpent(txid, Number(vout)).catch(() => 0);
  }
  return { checked: outpoints.length, released, inputs: spent };
}

export const resyncMessage = (r: HealReport): string =>
  r.released > 0
    ? `Checked ${r.checked} coins: ${r.released} had already been spent elsewhere and are cleared. Try your send again.`
    : `Checked ${r.checked} coins: all still spendable. Nothing to clear.`;

/** The cleared-list value for a coin cleared without a named spender (it is never compared as a txid). */
export const UNNAMED_SPENDER = 'unnamed';

/** Pure: the coins a heal cleared → their named spender, for the automatic check's cleared list (recordAutoCleared). */
export const healClearedEntries = (r: HealReport | null | undefined): Record<string, string> =>
  // A coin cleared on the broadcaster's word alone has no named spender: it is recorded too (UNNAMED_SPENDER), so the
  // automatic check can still put it back (17b L3).
  Object.fromEntries((r?.cleared ?? []).map((op) => [op, r?.spenders?.[op] || UNNAMED_SPENDER]));

/** After an invalidTx: release the rejected send's inputs proven spent. Never throws. */
export async function healInvalidSend(
  error: unknown,
  getSpend: (outpoint: string) => Promise<string | null | undefined>,
  store: HealStore,
  opts: { fallback?: (outpoint: string) => Promise<string | null | undefined>; reason?: string } = {},
): Promise<HealReport> {
  if (!isInvalidTxReview(error)) return { checked: 0, released: 0 };
  const inputs = rejectedInputs(error);
  const rejectedTxid = refusedTxid(error);
  const namedBy = reasonSpender(opts.reason);
  // The broadcaster named a DIFFERENT spender without the outpoint: with one input there is only one it can mean (17c,
  // S7: otherwise a blind index and WhatsOnChain leave the coin in place and every send fails on it).
  const named =
    namedSpentInputs(opts.reason, inputs).length || inputs.length !== 1 || !namedBy || namedBy === rejectedTxid
      ? namedSpentInputs(opts.reason, inputs)
      : inputs;
  const looked = await provenSpenders(
    inputs.filter((op) => !named.includes(op)),
    getSpend,
    opts.fallback,
    rejectedTxid,
  );
  const spenders: Record<string, string | null> = {
    ...Object.fromEntries(named.map((op) => [op, namedBy && namedBy !== rejectedTxid ? namedBy : null])),
    ...looked,
  };
  let released = 0;
  const cleared: string[] = [];
  const alreadyOff: string[] = [];
  // Counted when cleared now or already unspendable (clearOne): either way the retry can't pick it again. Whether the
  // retry runs is still decided by every guard in spentRetry.ts judge (proof it can't go out, not our own spender,
  // every spender named, double spends mined, orphans, one retry only).
  for (const op of Object.keys(spenders)) {
    const r = await clearOne(store, op);
    if (r.changed > 0) {
      released += r.changed;
      cleared.push(op);
    } else if (r.already) {
      released += 1;
      alreadyOff.push(op);
    }
  }
  return { checked: inputs.length, released, inputs, spenders, cleared, ...(alreadyOff.length ? { alreadyOff } : {}) };
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

/**
 * The error text with the heal outcome FIRST when coins were cleared. Owner's iPhone, 19 Oct 2026: the heal cleared
 * coins, but its "tap Send again" was appended after a long broadcaster reason and the page cuts errors at 400
 * characters, so only the raw UTXO_SPENT text showed.
 */
export const withHealMessage = (error: string, r: HealReport | null): string => {
  if (!r) return error;
  // A double spend may still go through (ARC keeps it), and a service error or a queued send has no verdict at all
  // (the retry may be on its way): never turned into "spent elsewhere, try again" (17b H1).
  if (/double ?spend|DOUBLE_SPEND|serviceError|service error|unknown|timed? ?out|queued|pending/i.test(error))
    return error;
  const m = healMessage(r).trim();
  if (!m) return error;
  // Coins cleared (and, for the wallet's own send, one automatic retry already tried): plain words only. The raw
  // toolbox/broadcaster text stays in the console log; owner, 23 Oct 2026.
  return r.released > 0 ? SPENT_ELSEWHERE_MESSAGE : `${error} ${m}`;
};
