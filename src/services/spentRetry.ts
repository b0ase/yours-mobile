/**
 * One automatic retry after a send the network refused because a coin was already spent (UTXO_SPENT).
 *
 * Owner's iPhone, 17 and 19 Oct 2026 (b_feedback 9, 15, 16): the same seed is used on the iPhone, the extension and
 * web. Coins spent from another device stay spendable in this device's storage (the toolbox's sync only adds
 * outputs), so a send picks one, the broadcaster answers "UTXO_SPENT … utxo already spent by tx …", and the toolbox
 * throws WERR_REVIEW_ACTIONS (status invalidTx). The toolbox has already failed the action and made its inputs
 * spendable again (locks released); invalidSendHeal then clears the inputs proven spent. Before this module the person
 * had to tap Send again, once per dead coin, and saw the raw toolbox text.
 *
 * Here, when the heal cleared at least one coin, the same createAction (same outputs, same amounts, same
 * description: what the person approved) is run ONCE more, which now funds from other coins. Never when:
 *   - the caller is not eligible (the wallet's own fixed-amount send only: no dApp, no explicit inputs, no send-all,
 *     no delayed/noSend/signAndProcess:false, no multi-step chain);
 *   - nothing was cleared (retrying would pick the same coins);
 *   - the rejected transaction may have gone out: the broadcaster names it as the spender, or the network lookup
 *     does not answer "unknown txid" (fail closed: no second payment unless we know the first did not happen);
 *   - a cleared coin's spender is a transaction THIS wallet holds, in any status, or can't be named or checked
 *     (review 17, F1, reproduced: a payment shown as failed had gone out; the heal cleared its coin and the retry paid
 *     the same payee again). The person is told that earlier payment went out (ownPaymentOutMessage);
 *   - after a double spend (DOUBLE_SPEND_ATTEMPTED), unless every competing spend is MINED: ARC keeps the refused tx,
 *     which is mined if the competitor drops (review 17, F2). The coins stay cleared; the person is told either payment
 *     may still go through (DOUBLE_SPEND_PENDING_MESSAGE).
 */
import type { HealReport } from './invalidSendHeal';
import { isInvalidTxReview, reasonSpender, refusal, refusedTxid, SPENT_ELSEWHERE_MESSAGE } from './invalidSendHeal';
import { DOUBLE_SPEND_PENDING_MESSAGE, ownPaymentOutMessage } from '../utils/sendErrors';

export { SPENT_ELSEWHERE_MESSAGE };

/** Pure: the txid of the transaction the network refused (WERR_REVIEW_ACTIONS' invalidTx or doubleSpend result). */
export const rejectedTxid = (error: unknown): string | undefined => refusedTxid(error);

/** Pure: does the broadcaster's reason name this txid as the spender ("already spent by tx <txid>")? */
export const reasonNamesSpender = (reason: string | undefined, txid: string): boolean =>
  !!reason && new RegExp(`spent by (?:tx )?${txid}`, 'i').test(reason);

/** Pure: the wallet's own fixed-amount send, funded by the wallet (the only kind retried). */
export function retryEligible(p: {
  isAdmin: boolean;
  continuing: boolean;
  delayed: boolean;
  sendAll: boolean;
  args: {
    inputs?: unknown[];
    inputBEEF?: unknown;
    options?: { signAndProcess?: boolean; noSend?: boolean; acceptDelayedBroadcast?: boolean };
  };
}): boolean {
  const o = p.args.options ?? {};
  return (
    p.isAdmin &&
    !p.continuing &&
    !p.delayed &&
    !p.sendAll &&
    !(p.args.inputs?.length ?? 0) &&
    !p.args.inputBEEF &&
    o.signAndProcess !== false &&
    o.noSend !== true &&
    o.acceptDelayedBroadcast !== true
  );
}

export interface SpentRetryDeps<R> {
  /** The createAction call, exactly as approved. Called at most twice. */
  create: () => Promise<R>;
  /** invalidSendHeal for this account. Never throws; null when it can't run. */
  heal: (error: unknown) => Promise<HealReport | null>;
  /** Is this txid known to the network? true/false, or null when the lookup can't tell (treated as "maybe sent"). */
  txKnown: (txid: string) => Promise<boolean | null>;
  /** The broadcaster's reason for a refused txid, if recorded. */
  reason?: (txid: string) => string | undefined;
  /**
   * Which of these txids this wallet's storage holds, ANY status (a payment of ours, maybe shown as failed, that may
   * have gone out). Throws or resolves null when it can't tell: then nothing is retried.
   */
  ownTxids: (txids: string[]) => Promise<Set<string> | null>;
  /** Is this outpoint's spend by `spender` MINED (WhatsOnChain "confirmed")? null when it can't tell. */
  spendMined: (outpoint: string, spender: string) => Promise<boolean | null>;
  eligible: boolean;
  log?: (msg: string, data?: unknown) => void;
}

/** `notice`: the plain sentence to show instead of the heal's "try again" (an earlier payment went out, …). */
export type SpentRetryOutcome<R> =
  | { ok: true; result: R; retried: boolean; heal: HealReport | null }
  | { ok: false; error: unknown; retried: boolean; heal: HealReport | null; notice?: string };

const addReports = (a: HealReport | null, b: HealReport | null): HealReport | null =>
  !a
    ? b
    : !b
      ? a
      : {
          checked: a.checked + b.checked,
          released: a.released + b.released,
          inputs: [...(a.inputs ?? []), ...(b.inputs ?? [])],
          spenders: { ...(a.spenders ?? {}), ...(b.spenders ?? {}) },
          cleared: [...(a.cleared ?? []), ...(b.cleared ?? [])],
        };

/**
 * The spenders behind a refusal (each proven-spent input's, and the one the broadcaster's reason names), and the first
 * that is a transaction this wallet holds. `own` is null when storage couldn't be asked.
 */
async function ownSpender(
  d: SpentRetryDeps<unknown>,
  heal: HealReport | null,
  txid: string | undefined,
): Promise<{ own: string | null | undefined; unnamed: boolean }> {
  const named = Object.values(heal?.spenders ?? {});
  const candidates = new Set<string>(named.filter((s): s is string => !!s));
  const fromReason = reasonSpender(txid ? d.reason?.(txid) : undefined);
  if (fromReason && fromReason !== txid) candidates.add(fromReason);
  const unnamed = named.some((s) => !s);
  if (!candidates.size) return { own: undefined, unnamed };
  const held = await Promise.resolve()
    .then(() => d.ownTxids([...candidates]))
    .catch(() => null);
  if (!held) return { own: null, unnamed };
  return { own: [...candidates].find((t) => held.has(t)), unnamed };
}

/** Run create; after a UTXO_SPENT refusal heal, and retry once when it is safe. Never throws. */
export async function createWithSpentRetry<R>(d: SpentRetryDeps<R>): Promise<SpentRetryOutcome<R>> {
  let first: unknown;
  try {
    return { ok: true, result: await d.create(), retried: false, heal: null };
  } catch (err) {
    first = err;
  }
  if (!isInvalidTxReview(first)) return { ok: false, error: first, retried: false, heal: null };
  const heal = await d.heal(first).catch(() => null);
  const txid = rejectedTxid(first);
  // Whatever happens next, a coin spent by a payment of ours means that payment went out: say so, never retry.
  const { own, unnamed } = await ownSpender(d as SpentRetryDeps<unknown>, heal, txid);
  const notice = own ? ownPaymentOutMessage(own) : undefined;
  const why = (() => {
    if (own) return 'a cleared coin was spent by a payment this wallet holds';
    if (!d.eligible) return 'not eligible';
    if (!heal || heal.released <= 0) return 'nothing cleared';
    if (!txid) return 'no rejected txid';
    if (reasonNamesSpender(d.reason?.(txid), txid)) return 'rejected tx named as spender';
    if (own === null) return "this wallet's own payments could not be checked";
    if (unnamed) return 'a cleared coin has no named spender';
    return null;
  })();
  if (why) {
    d.log?.(`[spentRetry] no retry: ${why}`);
    return { ok: false, error: first, retried: false, heal, notice };
  }
  if (refusal(first)?.status === 'doubleSpend') {
    // ARC keeps a double-spend attempt: it is mined if the other payment drops. Retry only when that can't happen.
    const spent = Object.entries(heal!.spenders ?? {});
    const mined = await Promise.all(
      spent.map(([op, by]) =>
        Promise.resolve()
          .then(() => d.spendMined(op, by!))
          .catch(() => null),
      ),
    );
    if (!spent.length || mined.some((m) => m !== true)) {
      d.log?.('[spentRetry] no retry: double spend with a competing payment not mined yet', { txid, mined });
      return { ok: false, error: first, retried: false, heal, notice: DOUBLE_SPEND_PENDING_MESSAGE };
    }
  }
  const known = await d.txKnown(txid!).catch(() => null);
  if (known !== false) {
    d.log?.('[spentRetry] no retry: the refused tx may be on the network', { txid, known });
    return { ok: false, error: first, retried: false, heal };
  }
  d.log?.('[spentRetry] coins cleared; retrying once with fresh inputs', { txid, released: heal!.released });
  try {
    return { ok: true, result: await d.create(), retried: true, heal };
  } catch (second) {
    const heal2 = isInvalidTxReview(second) ? await d.heal(second).catch(() => null) : null;
    const again = heal2 ? await ownSpender(d as SpentRetryDeps<unknown>, heal2, rejectedTxid(second)) : undefined;
    return {
      ok: false,
      error: second,
      retried: true,
      heal: addReports(heal, heal2),
      notice: again?.own ? ownPaymentOutMessage(again.own) : undefined,
    };
  }
}
