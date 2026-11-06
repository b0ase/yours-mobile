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
import { ORPHAN_MARK, recordAutoCleared, type KV } from './autoCoinResync';
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
  /** The clock for the second look at an unnamed missing parent (tests). */
  now?: () => number;
};

type Txo = { getSpend?: (o: string) => Promise<string | null | undefined> };
type StackStatus = { getStatusForTxids?: (t: string[]) => Promise<{ results?: { txid?: string; status?: string }[] }> };
type OutputRow = { outputId: number; change?: boolean; type?: string; basketId?: number | null; spendable?: boolean };
type MarkingProvider = {
  findUsers: (a: { partial: { identityKey: string } }) => Promise<{ userId: number }[]>;
  findOutputs: (a: {
    partial: { userId: number; txid: string; vout: number; spendable?: boolean };
    noScript?: boolean;
  }) => Promise<OutputRow[]>;
  findOutputBaskets: (a: { partial: { userId: number; name: string } }) => Promise<{ basketId: number }[]>;
  updateOutput: (id: number, u: { spendable: boolean }) => Promise<number>;
  findTransactions: (a: {
    partial: { userId: number; txid: string };
    noRawTx: true;
  }) => Promise<{ status?: string; provenTxId?: number | null }[]>;
};

/** Our own actions still on their way out (or mined): their change is never set aside as having no parent. */
const IN_FLIGHT = ['sending', 'unprocessed', 'unsigned', 'nosend', 'nonfinal', 'unfail'];
/** Unnamed: our own payment the network accepted is also left alone (17d M1: it may not be indexed yet). */
const IN_FLIGHT_OR_UNPROVEN = [...IN_FLIGHT, 'unproven'];
/**
 * A "Missing inputs" that names no input: a coin's parent must be unknown on two refusals at least this far apart
 * before the coin is set aside (17d M1: WhatsOnChain can lag minutes behind a fresh payment).
 */
export const ORPHAN_SECOND_LOOK_MS = 10 * 60 * 1000;
/** A first look older than this is stale: it starts the wait again. */
const ORPHAN_FIRST_LOOK_TTL_MS = 24 * 60 * 60 * 1000;
export const ORPHAN_SUSPECTS_KEY = 'bwxOrphanSuspects';
type Suspects = Record<string, Record<string, number>>;

/** The inputs a "Missing inputs" reason names: by outpoint (txid:vout) when it gives any, else by parent txid. */
export function missingNamed(reason: string | undefined, inputs: string[]): string[] {
  const t = (reason ?? '').toLowerCase();
  if (!t) return [];
  const exact = inputs.filter((op) => {
    const [txid, vout] = op.toLowerCase().split('_');
    return t.includes(`${txid}:${vout}`) || t.includes(`${txid}_${vout}`);
  });
  return exact.length ? exact : inputs.filter((op) => t.includes(op.split('_')[0].toLowerCase()));
}

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
 * check's list so it can put one back if both sources later call it unspent (review 17 F3, 17b L3).
 *
 * After a "Missing inputs" refusal, a coin whose parent payment the network can't find is set aside for now, so every
 * send stops failing on it (17c L3), within strict limits (17d M1):
 *   - only the input(s) the broadcaster's reason names (or the only input). An input it doesn't name needs the parent
 *     unknown on two refusals at least ORPHAN_SECOND_LOOK_MS apart, and is never set aside when the parent is a
 *     payment of ours still going out or accepted but not mined ('unproven');
 *   - the parent must be unknown to WhatsOnChain (404) and the 1Sat stack, and not mined or in flight in storage;
 *   - only plain change in the default basket (P2PKH): ordinals, tokens, locks and OpNS names are never touched;
 *   - each one is recorded on the automatic check's list with ORPHAN_MARK, and that check puts the coin back as soon
 *     as its parent shows up (autoCoinResync.ts txSeen).
 * Never throws.
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
  /**
   * Spendable now? false = this device's store already holds it unspendable (the toolbox's stale-input check after the
   * refused broadcast, owner's iPhone 3 Nov 2026, sign-and-seal 5cd462ce); null = no row, or the store can't be read
   * (a remote store throws): never counted.
   */
  const isSpendable = (txid: string, vout: number) =>
    run(async (sp) => {
      const user = (await sp.findUsers({ partial: { identityKey: c.identityKey } }))[0];
      if (!user) return null;
      const rows = await sp.findOutputs({ partial: { userId: user.userId, txid, vout }, noScript: true });
      return rows.length ? rows.some((o) => !!o.spendable) : null;
    }).catch(() => null);
  try {
    const reason = refusalFor(refusedTxid(error));
    const heal = await healInvalidSend(
      error,
      (o) => txo.getSpend!(o),
      { markSpent: setAside, isSpendable },
      {
        // WhatsOnChain names mempool and mined spenders alike.
        fallback: c.mainnet ? async (o) => (await wocSpentStatus(o, undefined, c.fetch))?.txid ?? null : undefined,
        reason,
      },
    );
    await recordAutoCleared(c.kv, c.identityKey, healClearedEntries(heal));
    if (/missing ?inputs/i.test(reason ?? '')) {
      const orphaned = await setAsideOrphans(c, run, rejectedInputs(error), reason, heal);
      if (orphaned.length) {
        c.log?.("[ownSend] coins whose parent the network can't find were set aside for now", orphaned);
        heal.orphaned = orphaned;
        await recordAutoCleared(c.kv, c.identityKey, Object.fromEntries(orphaned.map((op) => [op, ORPHAN_MARK])));
      }
    }
    return heal;
  } catch (err) {
    c.log?.('[ownSend] the heal after a refusal failed', err instanceof Error ? err.message : err);
    return null;
  }
}

/** 17d M1: the inputs of a "Missing inputs" refusal that are set aside, within the limits healRefusedInputs states. */
async function setAsideOrphans(
  c: SendChecksContext,
  run: <T>(f: (sp: MarkingProvider) => Promise<T>) => Promise<T>,
  inputs: string[],
  reason: string | undefined,
  heal: HealReport,
): Promise<string[]> {
  const named = missingNamed(reason, inputs);
  const sure = new Set(named.length ? named : inputs.length === 1 ? inputs : []);
  const now = (c.now ?? Date.now)();
  let suspects: Suspects | null = null;
  const orphaned: string[] = [];
  for (const op of inputs) {
    if (heal.spenders?.[op] !== undefined) continue; // spent: the heal handled it
    const [parent, voutText] = op.split('_');
    const vout = Number(voutText);
    // Plain change in the default basket, still spendable: nothing else is ever set aside here.
    const rows = await ask(() =>
      run(async (sp) => {
        const user = (await sp.findUsers({ partial: { identityKey: c.identityKey } }))[0];
        if (!user) return null;
        const basket = (await sp.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } }))[0];
        if (!basket) return null;
        const outs = await sp.findOutputs({
          partial: { userId: user.userId, txid: parent, vout, spendable: true },
          noScript: true,
        });
        const change = outs.filter((o) => o.change === true && o.type === 'P2PKH' && o.basketId === basket.basketId);
        const mine = (await sp.findTransactions({ partial: { userId: user.userId, txid: parent }, noRawTx: true }))[0];
        return { change, mine };
      }),
    );
    if (!rows?.change.length) continue;
    const status = rows.mine?.status;
    if (rows.mine?.provenTxId != null || status === 'completed') continue;
    if (status && (sure.has(op) ? IN_FLIGHT : IN_FLIGHT_OR_UNPROVEN).includes(status)) continue;
    if ((await chainKnowsTx(c, parent)) !== false) {
      if (suspects?.[c.identityKey]?.[op]) delete suspects[c.identityKey][op];
      continue;
    }
    if (!sure.has(op)) {
      // Not named: the first look only notes it; a second one at least ORPHAN_SECOND_LOOK_MS later sets it aside.
      suspects ??= await readSuspects(c);
      const mineSeen = (suspects[c.identityKey] ??= {});
      const first = mineSeen[op];
      const fresh = typeof first === 'number' && now - first <= ORPHAN_FIRST_LOOK_TTL_MS && now >= first;
      if (!fresh) {
        mineSeen[op] = now;
        continue;
      }
      if (now - first < ORPHAN_SECOND_LOOK_MS) continue;
      delete mineSeen[op];
    }
    const n = await ask(() =>
      run(async (sp) => {
        let k = 0;
        for (const o of rows.change) k += await sp.updateOutput(o.outputId, { spendable: false });
        return k;
      }),
    );
    if (n) orphaned.push(op);
  }
  if (suspects) await writeSuspects(c, suspects);
  return orphaned;
}

const readSuspects = async (c: SendChecksContext): Promise<Suspects> => {
  try {
    return ((await c.kv.get(ORPHAN_SUSPECTS_KEY))[ORPHAN_SUSPECTS_KEY] as Suspects | undefined) ?? {};
  } catch {
    return {};
  }
};
const writeSuspects = async (c: SendChecksContext, s: Suspects): Promise<void> => {
  const now = (c.now ?? Date.now)();
  for (const acct of Object.values(s))
    for (const [op, at] of Object.entries(acct ?? {})) if (now - at > ORPHAN_FIRST_LOOK_TTL_MS) delete acct[op];
  try {
    await c.kv.set({ [ORPHAN_SUSPECTS_KEY]: s });
  } catch {
    /* the first look is forgotten: the coin just waits longer */
  }
};

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
