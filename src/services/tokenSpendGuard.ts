/**
 * One guard for every BSV-21 spend (F-3, 16-18 Oct 2026: "inputs[0].unlockScript must be valid ... OP_DUP requires
 * at least one item to be on the stack").
 *
 * A token input is left with an empty unlock when its wallet record can't be signed: the record names a key that
 * doesn't derive the script's address, or it has no `id:` tracking tag (@1sat/actions builds its spends from that
 * tag and silently skips untagged inputs). The wallet's verifier then rejects the whole transaction before anything
 * is broadcast.
 *
 * withTokenKeyCheck wraps a spend:
 * 1. before building: the keys-only check (repairUnsignableTokenOutputs) on the tokens being spent, so a bad record
 *    is refiled (right key, tracking tag) or set aside BEFORE an input is picked. Records already verified on this
 *    wallet are remembered for the session, so repeat sends cost one listOutputs;
 * 2. after an empty-unlock failure (thrown or returned): the check again over every token, not cached, then the
 *    spend once more; a second empty unlock ends with EMPTY_UNLOCK_MESSAGE.
 *
 * guardedSendBsv21 is sendBsv21 with the guard: every caller of sendBsv21.execute uses it.
 */
import { sendBsv21, type OneSatContext } from '@1sat/actions';
import type { OneSatServices } from '@1sat/wallet-browser';
import type { WalletInterface } from '@bsv/sdk';
import { EMPTY_UNLOCK_MESSAGE, isEmptyUnlockError } from '../utils/bsv21SendErrors';
import { runUnseenHeal } from './tokenRecoveryWallet';

/** Runs the keys-only check: tokenId undefined = every token; fresh = ignore the verified cache. */
export type KeyCheckFn = (tokenId: string | undefined, fresh: boolean) => Promise<unknown>;

export type GuardOptions<T> = {
  /** The error text of a result that failed without throwing (e.g. sendBsv21's { error }). */
  failure?: (r: T) => unknown;
  log?: (msg: string) => void;
};

export class EmptyUnlockError extends Error {
  constructor() {
    super(EMPTY_UNLOCK_MESSAGE);
    this.name = 'EmptyUnlockError';
  }
}

/** The guard on its own (tests inject check). */
export async function guardTokenSpend<T>(
  check: KeyCheckFn,
  tokenIds: string | (string | undefined)[] | undefined,
  run: () => Promise<T>,
  opts: GuardOptions<T> = {},
): Promise<T> {
  const log = opts.log ?? ((m: string) => console.warn(`[tokenSpendGuard] ${m}`));
  const ids = [...new Set((Array.isArray(tokenIds) ? tokenIds : [tokenIds]).filter((t): t is string => !!t))];
  const pre = async () => {
    for (const id of ids.length ? ids : [undefined]) await check(id, false).catch(() => undefined);
  };
  const attempt = async (): Promise<{ ok: true; r: T } | { ok: false; error: unknown; r?: T; thrown: boolean }> => {
    try {
      const r = await run();
      const failed = opts.failure?.(r);
      if (failed && isEmptyUnlockError(failed)) return { ok: false, error: failed, r, thrown: false };
      return { ok: true, r };
    } catch (error) {
      if (isEmptyUnlockError(error)) return { ok: false, error, thrown: true };
      throw error;
    }
  };

  await pre();
  const first = await attempt();
  if (first.ok) return first.r;
  log(`empty unlock on a token input (F-3); checking every token record, then one retry`);
  await check(undefined, true).catch(() => undefined);
  const second = await attempt();
  if (second.ok) return second.r;
  log('empty unlock again after the key check');
  if (second.thrown || second.r === undefined) throw new EmptyUnlockError();
  return second.r;
}

type GuardCtx = { wallet: WalletInterface; services?: unknown };

/** Outputs verified per wallet this session (outpoint|ci|tagged), so the pre-check stays cheap. */
const verifiedByWallet = new WeakMap<object, Set<string>>();

/** The keys-only check bound to a wallet. */
export const keyCheckFor =
  (ctx: GuardCtx): KeyCheckFn =>
  async (tokenId, fresh) => {
    let verified = verifiedByWallet.get(ctx.wallet);
    if (!verified) verifiedByWallet.set(ctx.wallet, (verified = new Set()));
    if (fresh) verified.clear();
    return runUnseenHeal(
      { wallet: ctx.wallet, services: ctx.services as OneSatServices },
      { tokenId, keysOnly: true, verified },
    );
  };

/** Run a spend of tokenIds' outputs with the key check before it and one heal-and-retry on an empty unlock. */
export const withTokenKeyCheck = <T>(
  ctx: GuardCtx,
  tokenIds: string | (string | undefined)[] | undefined,
  run: () => Promise<T>,
  opts?: GuardOptions<T>,
): Promise<T> => guardTokenSpend(keyCheckFor(ctx), tokenIds, run, opts);

type SendInput = Parameters<typeof sendBsv21.execute>[1];
type SendResult = Awaited<ReturnType<typeof sendBsv21.execute>>;

/** sendBsv21 with the guard; a second empty unlock comes back as { error: EMPTY_UNLOCK_MESSAGE }. */
export const guardedSendBsv21 = {
  async execute(ctx: OneSatContext, input: SendInput): Promise<SendResult> {
    try {
      const r = await withTokenKeyCheck(ctx, input.tokenId, () => sendBsv21.execute(ctx, input), {
        failure: (x) => x.error,
      });
      return isEmptyUnlockError(r.error) ? { ...r, error: EMPTY_UNLOCK_MESSAGE } : r;
    } catch (e) {
      if (e instanceof EmptyUnlockError) return { error: EMPTY_UNLOCK_MESSAGE } as SendResult;
      throw e;
    }
  },
};
