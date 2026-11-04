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
 *   - the rejected transaction may have gone out: the broadcaster names it as the spender, or WhatsOnChain and the
 *     1Sat stack don't both say "unknown txid" (fail closed: no second payment unless we know the first did not
 *     happen). The person is told it may have gone out (17b M1: "not sent" only after that check);
 *   - a cleared coin's spender is a transaction THIS wallet holds, in any status, or can't be named or checked
 *     (review 17, F1, reproduced: a payment shown as failed had gone out; the heal cleared its coin and the retry paid
 *     the same payee again). The person is told that earlier payment went out when it paid the same payee, else that
 *     a coin went to another payment of this wallet (17b L1);
 *   - after a double spend (DOUBLE_SPEND_ATTEMPTED), unless every competing spend is MINED: ARC keeps the refused tx,
 *     which is mined if the competitor drops (review 17, F2). The coins stay cleared; the person is told this payment
 *     may still go through (DOUBLE_SPEND_PENDING_MESSAGE), in either round (17b H1).
 * Every refusal comes back with the sentence to show (`notice`), and with `mayBeOut` when the refused tx may still be
 * mined, so the caller can stop a manual re-tap from paying twice (services/sendGuard.ts).
 */
import type { HealReport } from './invalidSendHeal';
import { isInvalidTxReview, reasonSpender, refusal, refusedTxid, SPENT_ELSEWHERE_MESSAGE } from './invalidSendHeal';
import {
  DOUBLE_SPEND_PENDING_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
  REFUSED_NOT_SENT_MESSAGE,
} from '../utils/sendErrors';

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
  /** Does this payment of ours pay this send's payee? Absent, false or failing: it is not named as "to this payee". */
  samePayee?: (ownTxid: string) => Promise<boolean>;
  eligible: boolean;
  log?: (msg: string, data?: unknown) => void;
}

/**
 * A refused transaction that may still be (or become) on the chain. The caller remembers it against this payment's
 * payee and amount, so a manual re-tap can't pay twice (services/sendGuard.ts; 17b M1).
 */
export type MayBeOut = { txid: string; kind: 'refused' | 'doubleSpend'; competitors: Record<string, string> };

/**
 * `notice`: the plain sentence the person sees for a refusal (the background shows it instead of the toolbox text).
 * Every refusal gets one: "not sent" only when the chain confirms it (17b M1), "may still go through" for a double
 * spend not proven dead (17b H1), and an earlier payment of ours named only when it went to the same payee (17b L1).
 */
export type SpentRetryOutcome<R> =
  | { ok: true; result: R; retried: boolean; heal: HealReport | null }
  | {
      ok: false;
      error: unknown;
      retried: boolean;
      heal: HealReport | null;
      notice?: string;
      mayBeOut?: MayBeOut;
    };

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

/** Call a dependency; a throw (sync or async) is "can't tell". */
const ask = <T>(f: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(f)
    .catch(() => null);

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
  const held = await ask(() => d.ownTxids([...candidates]));
  if (!held) return { own: null, unnamed };
  return { own: [...candidates].find((t) => held.has(t)), unnamed };
}

type Verdict = { retry: boolean; why?: string; notice?: string; mayBeOut?: MayBeOut };

/** What a refusal means, in order of what can still move money. Never throws. */
async function judge(
  d: SpentRetryDeps<unknown>,
  error: unknown,
  heal: HealReport | null,
  firstRound: boolean,
): Promise<Verdict> {
  const ref = refusal(error);
  const txid = ref?.txid;
  const spenders = heal?.spenders ?? {};
  // 1. A double spend may still be mined (ARC keeps it) unless every competing spend is mined (17b H1, review 17 F2).
  if (ref?.status === 'doubleSpend') {
    const named = Object.entries(spenders).filter((e): e is [string, string] => !!e[1]);
    let dead = named.length > 0 && named.length === Object.keys(spenders).length;
    if (dead) dead = (await Promise.all(named.map(([op, by]) => ask(() => d.spendMined(op, by))))).every((m) => m);
    if (!dead)
      return {
        retry: false,
        why: 'double spend: the competing payment is not mined',
        notice: DOUBLE_SPEND_PENDING_MESSAGE,
        mayBeOut: txid ? { txid, kind: 'doubleSpend', competitors: Object.fromEntries(named) } : undefined,
      };
  }
  // 2. Has the refused tx itself gone out? Only a clean "not known" lets anyone say "not sent" or pay again (17b M1).
  const known = txid ? await ask(() => d.txKnown(txid)) : null;
  if (known !== false || reasonNamesSpender(d.reason?.(txid!), txid!))
    return {
      retry: false,
      why: 'the refused tx may be on the network',
      notice: REFUSED_MAYBE_SENT_MESSAGE,
      mayBeOut: txid ? { txid, kind: 'refused', competitors: {} } : undefined,
    };
  // 3. A coin spent by a payment this wallet holds (any status): that payment went out. Never retried (review 17 F1);
  //    it is named as "your earlier payment to this payee" only when it paid the same payee (17b L1).
  const { own, unnamed } = await ownSpender(d, heal, txid);
  if (own) {
    const same = d.samePayee ? (await ask(() => d.samePayee!(own))) === true : false;
    return {
      retry: false,
      why: 'a cleared coin was spent by a payment this wallet holds',
      notice: same ? ownPaymentOutMessage(own) : OWN_COIN_OTHER_PAYMENT_MESSAGE,
    };
  }
  // 4. The refused tx is not on the chain: "not sent" is true from here.
  const notSent = heal && heal.released > 0 ? SPENT_ELSEWHERE_MESSAGE : REFUSED_NOT_SENT_MESSAGE;
  const why = !d.eligible
    ? 'not eligible'
    : !firstRound
      ? 'already retried once'
      : !heal || heal.released <= 0
        ? 'nothing cleared'
        : own === null
          ? "this wallet's own payments could not be checked"
          : unnamed
            ? 'a cleared coin has no named spender'
            : null;
  return why ? { retry: false, why, notice: notSent } : { retry: true };
}

/** Run create; after a refusal heal, and retry once when it is safe. Never throws. */
export async function createWithSpentRetry<R>(d: SpentRetryDeps<R>): Promise<SpentRetryOutcome<R>> {
  let first: unknown;
  try {
    return { ok: true, result: await d.create(), retried: false, heal: null };
  } catch (err) {
    first = err;
  }
  if (!isInvalidTxReview(first)) return { ok: false, error: first, retried: false, heal: null };
  const heal = await ask(() => d.heal(first));
  const v = await judge(d as SpentRetryDeps<unknown>, first, heal, true);
  if (!v.retry) {
    d.log?.(`[spentRetry] no retry: ${v.why}`);
    return { ok: false, error: first, retried: false, heal, notice: v.notice, mayBeOut: v.mayBeOut };
  }
  d.log?.('[spentRetry] coins cleared; retrying once with fresh inputs', { released: heal!.released });
  try {
    return { ok: true, result: await d.create(), retried: true, heal };
  } catch (second) {
    if (!isInvalidTxReview(second)) return { ok: false, error: second, retried: true, heal };
    const heal2 = await ask(() => d.heal(second));
    const v2 = await judge(d as SpentRetryDeps<unknown>, second, heal2, false);
    d.log?.(`[spentRetry] the retry was refused too: ${v2.why}`);
    return {
      ok: false,
      error: second,
      retried: true,
      heal: addReports(heal, heal2),
      notice: v2.notice,
      mayBeOut: v2.mayBeOut,
    };
  }
}
