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
 *   - there is no hard proof the rejected transaction can't go out: the broadcaster didn't name a DIFFERENT spender
 *     for its input, and its inputs aren't all known spent by other transactions (17c: a WhatsOnChain 404 lags and
 *     proves nothing). The person is told "we can't confirm whether this went out";
 *   - a cleared coin's spender is a transaction THIS wallet holds, in any status, or can't be named or checked
 *     (review 17, F1, reproduced: a payment shown as failed had gone out; the heal cleared its coin and the retry paid
 *     the same payee again). The person is told that earlier payment went out when it paid the same payee, else that
 *     a coin went to another payment of this wallet (17b L1);
 *   - after a double spend (DOUBLE_SPEND_ATTEMPTED), unless every competing spend is MINED: ARC keeps the refused tx,
 *     which is mined if the competitor drops (review 17, F2). The coins stay cleared; the person is told this payment
 *     may still go through (DOUBLE_SPEND_PENDING_MESSAGE), in either round (17b H1).
 * Every refusal comes back with the sentence to show (`notice`), conservative by default (17c): "we can't confirm
 * whether this went out" unless there is hard proof it can't (provenNotSent). A manual re-tap is guarded on the Send
 * page by the recipient the person typed (utils/uncertainSends.ts).
 */
import type { HealReport } from './invalidSendHeal';
import { isInvalidTxReview, reasonSpender, refusal, refusedTxid, SPENT_ELSEWHERE_MESSAGE } from './invalidSendHeal';
import {
  DEVICE_NOT_ACTIVE_PATTERN,
  DOUBLE_SPEND_PENDING_MESSAGE,
  MISSING_PARENT_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  OWN_PAYMENTS_UNCHECKED_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
  REFUSED_NOT_SENT_MESSAGE,
  SPENT_ELSEWHERE_SHORT_MESSAGE,
} from '../utils/sendErrors';
import { isInsufficientFunds } from './fundingPrep';

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
 * `notice`: the plain sentence the person sees for a refusal (the background shows it instead of the toolbox text).
 * Every refusal gets one, conservative by default (17c): "we can't confirm whether this went out" unless there is hard
 * proof it can't go out; "may still go through" for a double spend not proven dead (17b H1); an earlier payment of ours
 * named only when it went to the same payee (17b L1, 17c M1).
 */
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
          ...(a.alreadyOff?.length || b.alreadyOff?.length
            ? { alreadyOff: [...(a.alreadyOff ?? []), ...(b.alreadyOff ?? [])] }
            : {}),
          orphaned: [...(a.orphaned ?? []), ...(b.orphaned ?? [])],
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

type Verdict = { retry: boolean; why?: string; notice?: string };

/**
 * Hard proof the refused transaction can never be mined (17c): the broadcaster named a DIFFERENT transaction as the
 * spender of its input, or every one of its inputs is known spent by other transactions. Had it gone out, each of its
 * inputs would be spent by it. A WhatsOnChain 404 is not proof (it lags up to 16 minutes; 17c H1).
 */
export function provenNotSent(txid: string | undefined, reason: string | undefined, heal: HealReport | null): boolean {
  if (!txid) return false;
  const named = reasonSpender(reason);
  if (named === txid) return false; // the broadcaster says this very tx spent the coin: it went out
  if (named) return true;
  const inputs = heal?.inputs ?? [];
  return inputs.length > 0 && inputs.every((op) => !!heal?.spenders?.[op] && heal.spenders[op] !== txid);
}

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
      };
  }
  // 2. A coin whose parent never reached the network was set aside (17c L3): say so; nothing is retried.
  if (heal?.orphaned?.length)
    return { retry: false, why: 'a coin had no parent on chain', notice: MISSING_PARENT_MESSAGE };
  // 3. Without hard proof the refused tx can't be mined, the person is told it may have gone out (17c).
  if (!provenNotSent(txid, txid ? d.reason?.(txid) : undefined, heal))
    return { retry: false, why: 'no proof the refused tx did not go out', notice: REFUSED_MAYBE_SENT_MESSAGE };
  // 4. A coin spent by a payment this wallet holds (any status): that payment went out. Never retried (review 17 F1);
  //    named as "your earlier payment to this payee" only when it paid the same payee (17b L1, 17c M1).
  const { own, unnamed } = await ownSpender(d, heal, txid);
  if (own) {
    const same = d.samePayee ? (await ask(() => d.samePayee!(own))) === true : false;
    return {
      retry: false,
      why: 'a cleared coin was spent by a payment this wallet holds',
      notice: same ? ownPaymentOutMessage(own) : OWN_COIN_OTHER_PAYMENT_MESSAGE,
    };
  }
  // 5. Proven not sent: "not sent" is true from here, unless this wallet's own payments couldn't be read: the coin's
  //    spender may then be an earlier payment of ours to this payee, so never "try again" (17d L3).
  if (own === null)
    return {
      retry: false,
      why: "this wallet's own payments could not be checked",
      notice: OWN_PAYMENTS_UNCHECKED_MESSAGE,
    };
  const notSent = heal && heal.released > 0 ? SPENT_ELSEWHERE_MESSAGE : REFUSED_NOT_SENT_MESSAGE;
  const why = !d.eligible
    ? 'not eligible'
    : !firstRound
      ? 'already retried once'
      : !heal || heal.released <= 0
        ? 'nothing cleared'
        : unnamed
          ? 'a cleared coin has no named spender'
          : null;
  return why ? { retry: false, why, notice: notSent } : { retry: true };
}

/**
 * The retry failed without a refusal. Before signing (short of funds, the coin check stopping it, a build error) it
 * can't have gone out; anything else may have (17c L4).
 */
const presignNotice = (e: unknown): string | undefined => {
  if (isInsufficientFunds(e)) return SPENT_ELSEWHERE_SHORT_MESSAGE;
  const code = String((e as { code?: unknown; name?: unknown } | null)?.code ?? (e as { name?: unknown })?.name ?? '');
  if (/^WERR_(SPENT_ELSEWHERE|INVALID_PARAMETER|INSUFFICIENT_FUNDS|LOCAL_STORE_NEEDED)/.test(code)) return undefined;
  // Refused before anything was built because this device's store wasn't active yet (services/deviceActive.ts).
  if (DEVICE_NOT_ACTIVE_PATTERN.test(String((e as { message?: unknown } | null)?.message ?? ''))) return undefined;
  return REFUSED_MAYBE_SENT_MESSAGE;
};

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
    return { ok: false, error: first, retried: false, heal, notice: v.notice };
  }
  d.log?.('[spentRetry] coins cleared; retrying once with fresh inputs', { released: heal!.released });
  try {
    return { ok: true, result: await d.create(), retried: true, heal };
  } catch (second) {
    if (!isInvalidTxReview(second))
      return { ok: false, error: second, retried: true, heal, notice: presignNotice(second) };
    const heal2 = await ask(() => d.heal(second));
    const v2 = await judge(d as SpentRetryDeps<unknown>, second, heal2, false);
    d.log?.(`[spentRetry] the retry was refused too: ${v2.why}`);
    return {
      ok: false,
      error: second,
      retried: true,
      heal: addReports(heal, heal2),
      notice: v2.notice,
    };
  }
}
