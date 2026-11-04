/**
 * The money path of the background's createAction, in one place (re-review 17b, L4). background.ts
 * processCWICreateAction calls these, and the end-to-end tests drive the same functions with the real wallet-toolbox,
 * so what is tested is what runs:
 *   - refusalChecks: the chain checks a refused send needs (the heal, "is the refused tx known", "is that spender ours",
 *     "is the competing spend mined");
 *   - sendWithChecks: the re-tap guard (sendGuard.ts), the pre-send coin check (coinPreflight.ts), and one safe retry
 *     (spentRetry.ts) around the caller's createAction stack;
 *   - sendFailureText: the sentence the page or the site gets (sites never get another payment's txid).
 */
import { armCoinPreflight, heldTxids, ownTxPaysAny, wocSpendMined, wocSpentStatus } from './coinPreflight';
import { createWithSpentRetry, type SpentRetryOutcome } from './spentRetry';
import { healClearedEntries, healInvalidSend, refusedTxid, withHealMessage, type HealReport } from './invalidSendHeal';
import { recordAutoCleared, type KV } from './autoCoinResync';
import { refusalFor } from './broadcastRefusals';
import { paymentKey, SendGuardError, type SendGuard } from './sendGuard';
import { wocLookup } from './unsentGuard';
import { withoutOwnTxids } from '../utils/sendErrors';

/** One account's storage and services, as the background holds them (null fields: not ready). */
export type SendChecksContext = {
  /** WalletStorageManager. */
  storage: unknown;
  /** OneSatServices: txo (spend index) and getStatusForTxids (the 1Sat stack). */
  services: unknown;
  identityKey: string;
  /** WhatsOnChain is asked on mainnet only. */
  mainnet: boolean;
  /** chrome.storage.local: the automatic coin check's cleared list. */
  kv: KV;
  fetch?: typeof fetch;
  log?: (m: string, d?: unknown) => void;
};

type Txo = { getSpend?: (o: string) => Promise<string | null | undefined> };
type StackStatus = { getStatusForTxids?: (t: string[]) => Promise<{ results?: { txid?: string; status?: string }[] }> };
type MarkingProvider = {
  findUsers: (a: { partial: { identityKey: string } }) => Promise<{ userId: number }[]>;
  findOutputs: (a: {
    partial: { userId: number; txid: string; vout: number; spendable: boolean };
  }) => Promise<{ outputId: number }[]>;
  updateOutput: (id: number, u: { spendable: boolean }) => Promise<number>;
};

const ask = <T>(f: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(f)
    .catch(() => null);

/**
 * After a refusal: clear the inputs the chain proves spent (invalidSendHeal.ts), and record them on the automatic
 * check's list so it can put one back if both sources later call it unspent (review 17 F3, 17b L3). Never throws.
 */
export async function healRefusedInputs(c: SendChecksContext | null, error: unknown): Promise<HealReport | null> {
  const txo = (c?.services as { txo?: Txo } | null)?.txo;
  const storage = c?.storage as { runAsStorageProvider?: <T>(f: (sp: MarkingProvider) => Promise<T>) => Promise<T> };
  if (!c || !c.identityKey || !txo?.getSpend || typeof storage?.runAsStorageProvider !== 'function') return null;
  try {
    const heal = await healInvalidSend(
      error,
      (o) => txo.getSpend!(o),
      {
        markSpent: (txid, vout) =>
          storage.runAsStorageProvider!(async (sp) => {
            const user = (await sp.findUsers({ partial: { identityKey: c.identityKey } }))[0];
            if (!user) return 0;
            let n = 0;
            for (const o of await sp.findOutputs({ partial: { userId: user.userId, txid, vout, spendable: true } }))
              n += await sp.updateOutput(o.outputId, { spendable: false });
            return n;
          }),
      },
      {
        // WhatsOnChain names mempool and mined spenders alike.
        fallback: c.mainnet ? async (o) => (await wocSpentStatus(o, undefined, c.fetch))?.txid ?? null : undefined,
        reason: refusalFor(refusedTxid(error)),
      },
    );
    await recordAutoCleared(c.kv, c.identityKey, healClearedEntries(heal));
    return heal;
  } catch (err) {
    c.log?.('[ownSend] the heal after a refusal failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Is this txid known to the chain? true when WhatsOnChain has it or the 1Sat stack calls it known or mined; false only
 * when WhatsOnChain answers 404 and the stack doesn't know it; null otherwise (17b M1).
 */
export async function chainKnowsTx(c: SendChecksContext | null, txid: string): Promise<boolean | null> {
  if (!c) return null;
  const woc = c.mainnet ? await wocLookup(c.fetch ? (u, i) => c.fetch!(u, i) : undefined)(txid) : 'unclear';
  if (woc === 'seen') return true;
  const stack = (c.services as StackStatus | null)?.getStatusForTxids;
  if (stack) {
    const r = await ask(() => stack.call(c.services, [txid]));
    const s = r?.results?.find((x) => x?.txid === txid)?.status;
    if (s === 'known' || s === 'mined') return true;
  }
  return woc === 'missing' ? false : null;
}

/** The chain checks createWithSpentRetry needs for one account. Without an account every answer is "can't tell". */
export function refusalChecks(c: SendChecksContext | null) {
  return {
    heal: (error: unknown) => healRefusedInputs(c, error),
    txKnown: (txid: string) => chainKnowsTx(c, txid),
    reason: (txid: string) => refusalFor(txid),
    ownTxids: (txids: string[]) => (c ? heldTxids(c.storage, c.identityKey, txids) : Promise.resolve(null)),
    spendMined: (op: string, by: string) =>
      c?.mainnet ? wocSpendMined(op, by, c.fetch) : Promise.resolve<boolean | null>(null),
  };
}
export type RefusalChecks = ReturnType<typeof refusalChecks>;

export type SendWithChecksOutcome<R> = SpentRetryOutcome<R> & { cleared: number };

/**
 * Run the caller's createAction stack with the wallet's own-send protections. For the wallet's own fixed-amount send
 * (`ownSend`): the re-tap guard first, then the pre-send coin check is armed, and a refusal that may have gone out is
 * remembered. For every caller: a refusal is healed and judged (one retry only for the wallet's own send). Never throws.
 */
export async function sendWithChecks<R>(o: {
  create: () => Promise<R>;
  /** The payment's outputs (payee scripts and amounts). */
  outputs: { lockingScript?: string; satoshis?: number }[] | undefined;
  ownSend: boolean;
  context: SendChecksContext | null;
  checks?: RefusalChecks;
  guard?: SendGuard;
  log?: (m: string, d?: unknown) => void;
}): Promise<SendWithChecksOutcome<R>> {
  const c = o.context;
  const checks = o.checks ?? refusalChecks(c);
  const key = o.ownSend && c ? paymentKey(c.identityKey, o.outputs) : null;
  if (key && o.guard) {
    const g = await o.guard.check(key);
    if (!g.go) {
      o.log?.('[ownSend] an earlier try of this payment may have gone out; not sending again', { txid: g.txid });
      return {
        ok: false,
        error: new SendGuardError(g.message, g.txid),
        retried: false,
        heal: null,
        notice: g.message,
        cleared: 0,
      };
    }
  }
  const scripts = (o.outputs ?? []).map((x) => x.lockingScript ?? '').filter(Boolean);
  const preflight = armCoinPreflight(o.ownSend);
  let outcome: SpentRetryOutcome<R>;
  try {
    outcome = await createWithSpentRetry({
      create: o.create,
      ...checks,
      samePayee: (txid) => (c ? ownTxPaysAny(c.storage, c.identityKey, txid, scripts) : Promise.resolve(false)),
      eligible: o.ownSend,
      log: o.log,
    });
  } finally {
    preflight.done();
  }
  if (!outcome.ok && outcome.mayBeOut && key && o.guard) await o.guard.record(key, outcome.mayBeOut);
  return { ...outcome, cleared: preflight.cleared };
}

/**
 * The sentence a failed send answers with: the retry stack's own sentence when it has one, else the heal's plain words
 * over the error text. A site never gets the txid of another payment of this wallet (17b L1).
 */
export function sendFailureText(o: {
  errorText: string;
  heal: HealReport | null | undefined;
  notice?: string;
  isSite: boolean;
}): string {
  const text = o.notice ?? withHealMessage(o.errorText, o.heal ?? null);
  return o.isSite ? withoutOwnTxids(text) : text;
}
