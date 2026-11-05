/**
 * The money path of the background's createAction, in one place (re-review 17b, L4). background.ts
 * processCWICreateAction calls these, and the end-to-end tests drive the same functions with the real wallet-toolbox,
 * so what is tested is what runs:
 *   - refusalChecks: what a refused send needs (the heal, "is that spender ours", "is the competing spend mined");
 *   - sendWithChecks: the pre-send coin check (coinPreflight.ts) and one safe retry (spentRetry.ts) around the caller's
 *     createAction stack;
 *   - sendFailureText: the sentence the page or the site gets (sites never get another payment's txid).
 * A manual re-tap is guarded on the Send page, by the recipient the person typed (utils/uncertainSends.ts; 17c), not
 * here: chain data lags, and the page knows who the person meant to pay.
 */
import { armCoinPreflight, heldTxids, ownTxPaysAny, wocSpendMined, wocSpentStatus } from './coinPreflight';
import { createWithSpentRetry, type SpentRetryOutcome } from './spentRetry';
import {
  healClearedEntries,
  healInvalidSend,
  rejectedInputs,
  refusedTxid,
  withHealMessage,
  type HealReport,
} from './invalidSendHeal';
import { recordAutoCleared, type KV } from './autoCoinResync';
import { refusalFor } from './broadcastRefusals';
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
  findTransactions: (a: {
    partial: { userId: number; txid: string };
    noRawTx: true;
  }) => Promise<{ status?: string; provenTxId?: number | null }[]>;
};

/** Our own actions still on their way out: their change is never called "never reached the network". */
const IN_FLIGHT = ['sending', 'unprocessed', 'unsigned', 'nosend'];

const ask = <T>(f: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(f)
    .catch(() => null);

/**
 * Is this txid known to the chain? true when WhatsOnChain has it or the 1Sat stack calls it known or mined; false when
 * WhatsOnChain answers 404 and the stack doesn't know it; null otherwise. A false here is NEVER proof that a refused
 * payment didn't go out (WhatsOnChain lags; 17c H1): it is used only to find a coin's parent that never got anywhere.
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

/**
 * After a refusal: clear the inputs the chain proves spent (invalidSendHeal.ts), and record them on the automatic
 * check's list so it can put one back if both sources later call it unspent (review 17 F3, 17b L3). After a "missing
 * inputs" refusal, a coin whose parent payment never reached the network (unknown to WhatsOnChain and the 1Sat stack,
 * not mined in storage, not one of our own payments still going out) is set aside, so every send stops failing on it
 * (17c L3; Find missing coins brings it back if that payment confirms later). Never throws.
 */
export async function healRefusedInputs(c: SendChecksContext | null, error: unknown): Promise<HealReport | null> {
  const txo = (c?.services as { txo?: Txo } | null)?.txo;
  const storage = c?.storage as { runAsStorageProvider?: <T>(f: (sp: MarkingProvider) => Promise<T>) => Promise<T> };
  if (!c || !c.identityKey || !txo?.getSpend || typeof storage?.runAsStorageProvider !== 'function') return null;
  const run = storage.runAsStorageProvider.bind(storage);
  const setAside = (txid: string, vout: number) =>
    run(async (sp) => {
      const user = (await sp.findUsers({ partial: { identityKey: c.identityKey } }))[0];
      if (!user) return 0;
      let n = 0;
      for (const o of await sp.findOutputs({ partial: { userId: user.userId, txid, vout, spendable: true } }))
        n += await sp.updateOutput(o.outputId, { spendable: false });
      return n;
    });
  try {
    const reason = refusalFor(refusedTxid(error));
    const heal = await healInvalidSend(
      error,
      (o) => txo.getSpend!(o),
      { markSpent: setAside },
      {
        // WhatsOnChain names mempool and mined spenders alike.
        fallback: c.mainnet ? async (o) => (await wocSpentStatus(o, undefined, c.fetch))?.txid ?? null : undefined,
        reason,
      },
    );
    await recordAutoCleared(c.kv, c.identityKey, healClearedEntries(heal));
    if (/missing ?inputs/i.test(reason ?? '')) {
      const orphaned: string[] = [];
      for (const op of rejectedInputs(error)) {
        if (heal.spenders?.[op]) continue; // spent: the heal handled it
        const [parent, vout] = op.split('_');
        const mine = await ask(() =>
          run(async (sp) => {
            const user = (await sp.findUsers({ partial: { identityKey: c.identityKey } }))[0];
            return user
              ? (await sp.findTransactions({ partial: { userId: user.userId, txid: parent }, noRawTx: true }))[0]
              : undefined;
          }),
        );
        if (mine?.provenTxId != null || (mine?.status && IN_FLIGHT.includes(mine.status))) continue;
        if ((await chainKnowsTx(c, parent)) !== false) continue;
        if ((await ask(() => setAside(parent, Number(vout)))) ?? 0) orphaned.push(op);
      }
      if (orphaned.length) {
        c.log?.('[ownSend] coins whose parent never reached the network were set aside', orphaned);
        heal.orphaned = orphaned;
      }
    }
    return heal;
  } catch (err) {
    c.log?.('[ownSend] the heal after a refusal failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** What a refused send needs for one account. Without an account every answer is "can't tell". */
export function refusalChecks(c: SendChecksContext | null) {
  return {
    heal: (error: unknown) => healRefusedInputs(c, error),
    reason: (txid: string) => refusalFor(txid),
    ownTxids: (txids: string[]) => (c ? heldTxids(c.storage, c.identityKey, txids) : Promise.resolve(null)),
    spendMined: (op: string, by: string) =>
      c?.mainnet ? wocSpendMined(op, by, c.fetch) : Promise.resolve<boolean | null>(null),
  };
}
export type RefusalChecks = ReturnType<typeof refusalChecks>;

export type SendWithChecksOutcome<R> = SpentRetryOutcome<R> & { cleared: number };

/**
 * Run the caller's createAction stack with the wallet's own-send protections: for the wallet's own fixed-amount send
 * (`ownSend`) the pre-send coin check is armed and one safe retry is allowed; for every caller a refusal is healed and
 * judged. Never throws.
 */
export async function sendWithChecks<R>(o: {
  create: () => Promise<R>;
  /** The payment's outputs (payee scripts and amounts). */
  outputs: { lockingScript?: string; satoshis?: number }[] | undefined;
  ownSend: boolean;
  context: SendChecksContext | null;
  checks?: RefusalChecks;
  log?: (m: string, d?: unknown) => void;
}): Promise<SendWithChecksOutcome<R>> {
  const c = o.context;
  const checks = o.checks ?? refusalChecks(c);
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
