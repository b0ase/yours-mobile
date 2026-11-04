/**
 * Check the coins a send is about to spend against the chain BEFORE it is signed or broadcast (owner's iPhone,
 * 4 Nov 2026: the same seed is in the Chrome extension, which spent three coins of 87ccbc90… at 14:04Z and 14:33Z; the
 * phone still listed them as spendable, showed ~$10.50 when the truth was ~$0.16, and its $10 send "wouldn't send".
 * The owner no longer trusts the iPhone wallet).
 *
 * Coin selection happens inside the toolbox's storage createAction. This module wraps that one call
 * (WalletStorageManager.createAction) for the wallet's own sends (armCoinPreflight, held by the background around the
 * send). After storage has picked and locked the coins, and before anything is signed:
 *   1. every coin picked is looked up on the 1sat spend index (one batched call) and WhatsOnChain
 *      `/v1/bsv/main/tx/{txid}/{vout}/spent` (the biggest first, at most 3 requests a second), in parallel, each with a
 *      short timeout;
 *   2. a coin counts as spent elsewhere under the automatic coin check's rule (autoCoinResync.ts): the index AND
 *      WhatsOnChain name the same spender (mempool or mined), or WhatsOnChain names a MINED spender, and that spender
 *      is not one of this wallet's own unfinished or failed actions (withoutOwnSpenders: our payment may have gone
 *      out, so picking other coins could pay twice). One unconfirmed source alone never clears a coin: the send goes
 *      ahead as today and the broadcaster decides (its refusal is the second source; invalidSendHeal + spentRetry then
 *      clear the coin and retry once);
 *   3. if any coin is spent elsewhere: the planned action is aborted (the toolbox's own abortAction: the action is
 *      unsigned, never broadcast, has no txid; its coins are released), the spent coins are marked spendable=false with
 *      the spender recorded (spentBy when storage knows that transaction, and the automatic check's cleared list so a
 *      later run re-checks and can undo it), and storage picks again ONCE. If the new pick is clean the send goes on
 *      with it; if it is short of funds, or picks another spent coin, the send stops with SpentElsewhereError ("Some of
 *      your coins were already spent from another device…"), nothing signed.
 * Fail open: a lookup that times out or errors leaves that coin as it is. If neither source answers, the send goes
 * ahead exactly as before this module (logged). A failed abort also goes ahead as before: the coins stay locked to the
 * planned action, which would otherwise be stuck.
 */
import { SPENT_ELSEWHERE_MESSAGE, SPENT_ELSEWHERE_SHORT_MESSAGE } from '../utils/sendErrors';
import { recordAutoCleared, type KV, type WocAnswer } from './autoCoinResync';
import { isInsufficientFunds } from './fundingPrep';

const TXID = /^[0-9a-f]{64}$/i;

/** Per lookup. A send waits at most about this long (plus one second per 3 WhatsOnChain lookups after the first 3). */
export const PREFLIGHT_TIMEOUT_MS = 2_500;
/** WhatsOnChain lookups per check (the biggest coins first); further coins get the index only. */
export const PREFLIGHT_MAX_WOC = 6;
/**
 * WhatsOnChain requests started per second: anonymous WhatsOnChain allows about 3 a second, so a send with up to 3
 * coins waits one round trip, and coins 4–6 start a second later.
 */
export const PREFLIGHT_WOC_PER_SECOND = 3;
export const WOC_MAIN = 'https://api.whatsonchain.com/v1/bsv/main';
export const SPENT_ELSEWHERE_CODE = 'WERR_SPENT_ELSEWHERE';

/** The send stopped before signing: coins it picked were spent from another device, and they are now cleared. */
export class SpentElsewhereError extends Error {
  readonly code = SPENT_ELSEWHERE_CODE;
  readonly isError = true;
  constructor(
    /** The coins left can't pay for it (retrying would only fail). */
    readonly short: boolean,
    /** Outpoints ("txid_vout") cleared. */
    readonly cleared: string[],
    /** What storage said on the second pick, if it failed. */
    readonly original?: unknown,
  ) {
    super(short ? SPENT_ELSEWHERE_SHORT_MESSAGE : SPENT_ELSEWHERE_MESSAGE);
    this.name = SPENT_ELSEWHERE_CODE;
  }
}

export type PreflightCoin = { outpoint: string; satoshis: number };
export type SpentCoin = { outpoint: string; spender: string; confirmed: boolean };
export type PreflightReport = {
  checked: number;
  /** Proven spent by another transaction (the rule above). */
  spent: SpentCoin[];
  /** One source alone names a spender that isn't mined: left as it is (the broadcaster decides). */
  suspect: string[];
  /** Neither source answered for these. */
  unknown: string[];
};

export interface PreflightLookups {
  /** 1sat spend index, batched ("txid_vout"): a spender txid, null/undefined/'' when unspent; throws when it can't tell. */
  index?: (outpoints: string[]) => Promise<(string | null | undefined)[]>;
  /** WhatsOnChain: the spender (mempool or mined), null when unspent (404); throws when it can't tell. */
  woc?: (outpoint: string, signal?: AbortSignal) => Promise<WocAnswer>;
  timeoutMs?: number;
  maxWoc?: number;
  /** WhatsOnChain requests started per second (0 = no pacing). */
  wocPerSecond?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run f with a deadline; the signal is aborted when it passes. Rejects on timeout. */
async function withDeadline<T>(f: (signal?: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      f(ac?.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac?.abort();
          reject(new Error(`timed out after ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const asTxid = (t: unknown): string | null => (typeof t === 'string' && TXID.test(t) ? t.toLowerCase() : null);

/** Pure apart from the lookups: which of these coins another transaction has spent. Never throws. */
export async function checkCoins(coins: PreflightCoin[], d: PreflightLookups): Promise<PreflightReport> {
  const timeoutMs = d.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const perSecond = d.wocPerSecond ?? PREFLIGHT_WOC_PER_SECOND;
  const sleep = d.sleep ?? defaultSleep;
  const ops = coins.map((c) => c.outpoint);
  const indexAsk = d.index;
  const index: Promise<(string | null | undefined)[] | null> = indexAsk
    ? withDeadline(() => indexAsk(ops), timeoutMs)
        .then((r) => (Array.isArray(r) && r.length === ops.length ? r : null))
        .catch(() => null)
    : Promise.resolve(null);
  const wocAsk = d.woc;
  const wocOrder = [...coins]
    .sort((a, b) => b.satoshis - a.satoshis)
    .slice(0, d.maxWoc ?? PREFLIGHT_MAX_WOC)
    .map((c) => c.outpoint);
  const woc = Promise.all(
    wocOrder.map(async (o, i): Promise<[string, WocAnswer | undefined]> => {
      if (!wocAsk) return [o, undefined];
      // Bursts of `perSecond`, one second apart: never more than that many started in any second.
      const wait = perSecond > 0 ? Math.floor(i / perSecond) * 1000 : 0;
      if (wait > 0) await sleep(wait);
      try {
        return [o, await withDeadline((signal) => wocAsk(o, signal), timeoutMs)];
      } catch {
        return [o, undefined];
      }
    }),
  );
  const [ix, w] = await Promise.all([index, woc]);
  const wocBy = new Map(w);
  const report: PreflightReport = { checked: coins.length, spent: [], suspect: [], unknown: [] };
  ops.forEach((o, j) => {
    const fromIndex = ix ? asTxid(ix[j]) : null;
    const answer = wocBy.get(o);
    const fromWoc = answer ? asTxid(answer.txid) : null;
    if (fromIndex && fromWoc === fromIndex)
      report.spent.push({ outpoint: o, spender: fromIndex, confirmed: !!answer?.confirmed });
    else if (fromWoc && answer?.confirmed) report.spent.push({ outpoint: o, spender: fromWoc, confirmed: true });
    else if (fromIndex || fromWoc) report.suspect.push(o);
    else if ((!ix || ix[j] === undefined) && answer === undefined) report.unknown.push(o);
  });
  return report;
}

/** WhatsOnChain's spender for an outpoint ("txid_vout"): null when unspent (404); throws when it can't tell. */
export async function wocSpentStatus(
  outpoint: string,
  signal?: AbortSignal,
  f: typeof fetch = (...a) => fetch(...a),
): Promise<WocAnswer> {
  const [txid, vout] = outpoint.split('_');
  if (!TXID.test(txid) || !/^\d+$/.test(vout ?? '')) throw new Error(`bad outpoint ${outpoint}`);
  const r = await f(`${WOC_MAIN}/tx/${txid}/${vout}/spent`, { signal, credentials: 'omit' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`woc ${r.status}`);
  const j = (await r.json()) as { txid?: unknown; status?: unknown };
  if (typeof j.txid !== 'string') throw new Error('woc: no spender');
  return { txid: j.txid, confirmed: j.status === 'confirmed' };
}

// ── Scope: only the wallet's own sends, while the background holds a scope ────────────────────────────────────────

export type PreflightScope = { cleared: number; done: () => void };
const scopes = new Set<PreflightScope>();

/**
 * Turn the check on for the wallet's own send the caller is about to make (the background, around its createAction
 * retry stack). Not eligible: a no-op scope. Concurrent calls by the wallet itself while a scope is held are checked
 * too (harmless: the check only frees and re-picks storage's own coins); site calls never are (`checkApplies`).
 */
export function armCoinPreflight(eligible: boolean): PreflightScope {
  const scope: PreflightScope = { cleared: 0, done: () => void scopes.delete(scope) };
  if (eligible) scopes.add(scope);
  return scope;
}

type StorageArgs = {
  inputs?: unknown[];
  isNoSend?: boolean;
  isSignAction?: boolean;
  bwxWalletOriginated?: boolean;
};

/**
 * Pure: does the check apply to this storage createAction? A scope is held, the wallet itself is the caller (the
 * toolbox patch marks it; sites never are), storage picks every coin (no explicit inputs), and the wallet signs and
 * sends it itself (not noSend, not a two-step sign). A delayed broadcast is checked too: the BRC-100 default makes a
 * call that leaves acceptDelayedBroadcast unset "delayed", and the check runs before signing either way.
 */
export const checkApplies = (args: StorageArgs | undefined, armed: boolean): boolean =>
  armed &&
  args?.bwxWalletOriginated === true &&
  (args.inputs?.length ?? 0) === 0 &&
  args.isNoSend !== true &&
  args.isSignAction !== true;

type PlannedInput = { sourceTxid?: string; sourceVout?: number; sourceSatoshis?: number };
type Planned = { reference?: string; inputs?: PlannedInput[] };

/** Pure: the coins a storage createAction result spends. */
export const plannedCoins = (r: Planned | undefined): PreflightCoin[] =>
  (r?.inputs ?? [])
    .filter((i) => typeof i.sourceTxid === 'string' && TXID.test(i.sourceTxid) && Number.isInteger(i.sourceVout))
    .map((i) => ({
      outpoint: `${i.sourceTxid!.toLowerCase()}_${i.sourceVout}`,
      satoshis: Number(i.sourceSatoshis) || 0,
    }));

export interface PreflightDeps {
  check: (coins: PreflightCoin[]) => Promise<PreflightReport>;
  /** Mark these coins spendable=false with their spender; resolves how many rows changed. */
  markSpent: (spent: SpentCoin[]) => Promise<number>;
  /** This device's own store is the active one (the check never runs against a remote store). */
  isLocal: () => boolean;
  armed?: () => boolean;
  log?: (m: string, d?: unknown) => void;
}

type ManagerLike = {
  createAction?: (args: unknown) => Promise<unknown>;
  abortAction?: (args: { reference: string }) => Promise<unknown>;
  __bwxCoinPreflight?: boolean;
};

/**
 * Wrap WalletStorageManager.createAction (see the header). Returns false when there is nothing to wrap. The wrapper
 * never throws for a lookup or storage problem of its own; it throws only SpentElsewhereError (nothing signed), or
 * what storage itself threw.
 */
export function installCoinPreflight(storage: unknown, d: PreflightDeps): boolean {
  const s = storage as ManagerLike | null;
  if (!s || typeof s.createAction !== 'function' || typeof s.abortAction !== 'function') return false;
  if (s.__bwxCoinPreflight) return true;
  const original = s.createAction.bind(s);
  const abort = s.abortAction.bind(s);
  const log = d.log ?? ((m: string, x?: unknown) => console.warn(m, x ?? ''));
  const armed = d.armed ?? (() => scopes.size > 0);
  s.createAction = async (args: unknown) => {
    let plan = (await original(args)) as Planned;
    if (!checkApplies(args as StorageArgs, armed()) || !d.isLocal()) return plan;
    const cleared: string[] = [];
    for (let round = 1; ; round++) {
      const coins = plannedCoins(plan);
      if (!coins.length) return plan;
      const t0 = Date.now();
      const report = await d.check(coins).catch((e: unknown) => {
        log('[coinPreflight] check failed; sending as before', e instanceof Error ? e.message : e);
        return null;
      });
      if (!report) return plan;
      if (report.unknown.length === coins.length)
        log('[coinPreflight] the chain could not be reached; sending as before (the broadcaster decides)');
      else if (report.suspect.length)
        log('[coinPreflight] one source alone says spent; sending as before (the broadcaster decides)', report.suspect);
      if (!report.spent.length) {
        log(`[coinPreflight] ${coins.length} coin(s) checked in ${Date.now() - t0} ms: none spent elsewhere`);
        return plan;
      }
      log('[coinPreflight] coins spent from another device; releasing this plan before signing', report.spent);
      try {
        await abort({ reference: String(plan.reference) });
      } catch (e) {
        // The coins stay locked to the plan: go on as before this check rather than leave them stuck.
        log('[coinPreflight] could not release the plan; sending as before', e instanceof Error ? e.message : e);
        return plan;
      }
      const n = await d.markSpent(report.spent).catch((e: unknown) => {
        log('[coinPreflight] could not mark the spent coins', e instanceof Error ? e.message : e);
        return 0;
      });
      cleared.push(...report.spent.map((c) => c.outpoint));
      for (const sc of scopes) sc.cleared += Math.max(n, report.spent.length);
      if (round >= 2) throw new SpentElsewhereError(false, cleared);
      try {
        plan = (await original(args)) as Planned;
      } catch (e) {
        if (isInsufficientFunds(e)) throw new SpentElsewhereError(true, cleared, e);
        throw e;
      }
    }
  };
  s.__bwxCoinPreflight = true;
  return true;
}

/** This wallet's own actions that are not settled; their txids are never "spenders" (autoCoinResync.ts's rule). */
export const OWN_UNFINISHED_STATUSES = ['unsigned', 'nosend', 'sending', 'unprocessed', 'failed'];

/**
 * Pure: a coin whose spender is one of this wallet's own unfinished or failed actions is not "spent elsewhere": that
 * payment of ours may have gone out (a refusal storage took at face value), so picking other coins here could pay
 * twice. Such coins are left to the broadcaster and the existing heal, exactly as before this check.
 */
export function withoutOwnSpenders(r: PreflightReport, own: Set<string>): PreflightReport {
  if (!own.size) return r;
  const mine = r.spent.filter((c) => own.has(c.spender));
  if (!mine.length) return r;
  return {
    ...r,
    spent: r.spent.filter((c) => !own.has(c.spender)),
    suspect: [...r.suspect, ...mine.map((c) => c.outpoint)],
  };
}

// ── Wiring for one account (initWallet) ───────────────────────────────────────────────────────────────────────────

type StorageProviderLike = {
  findUsers: (a: { partial: { identityKey: string } }) => Promise<{ userId: number }[]>;
  findOutputs: (a: {
    partial: { userId: number; txid: string; vout: number; spendable: boolean };
    noScript?: boolean;
  }) => Promise<{ outputId: number }[]>;
  findTransactions: (a: {
    partial: { userId: number; txid: string };
    noRawTx: true;
  }) => Promise<{ transactionId: number; status?: string }[]>;
  updateOutput: (id: number, u: { spendable: boolean; spentBy?: number }) => Promise<number>;
};
type ManagerForWiring = ManagerLike & {
  isActiveStorageProvider: () => boolean;
  runAsStorageProvider: <T>(f: (sp: StorageProviderLike) => Promise<T>) => Promise<T>;
};

/**
 * Install the check on an account's storage manager with the real lookups (the services' 1sat txo client and
 * WhatsOnChain, mainnet only) and the real marking (this store; the automatic check's cleared list in `kv`).
 */
export function installCoinPreflightForWallet(
  storage: unknown,
  services: unknown,
  o: {
    identityKey: string;
    chain?: string;
    kv?: KV;
    fetch?: typeof fetch;
    lookups?: Omit<PreflightLookups, 'index' | 'woc'>;
    log?: (m: string, d?: unknown) => void;
  },
): boolean {
  const m = storage as ManagerForWiring;
  if (!m || typeof m.runAsStorageProvider !== 'function') return false;
  const txo = (services as { txo?: { getSpends?: (o: string[]) => Promise<(string | null | undefined)[]> } } | null)
    ?.txo;
  const mainnet = (o.chain ?? 'main') === 'main';
  const index = txo?.getSpends ? (ops: string[]) => txo.getSpends!(ops) : undefined;
  const woc = mainnet ? (op: string, signal?: AbortSignal) => wocSpentStatus(op, signal, o.fetch) : undefined;
  /** Which of these txids are this wallet's own unfinished or failed actions (an unreadable store: none). */
  const ownUnfinished = (txids: string[]) =>
    m
      .runAsStorageProvider(async (sp) => {
        const user = (await sp.findUsers({ partial: { identityKey: o.identityKey } }))[0];
        const own = new Set<string>();
        if (!user) return own;
        for (const txid of new Set(txids)) {
          const [t] = await sp.findTransactions({ partial: { userId: user.userId, txid }, noRawTx: true });
          if (t?.status && OWN_UNFINISHED_STATUSES.includes(t.status)) own.add(txid);
        }
        return own;
      })
      .catch(() => new Set<string>());
  return installCoinPreflight(storage, {
    check: async (coins) => {
      const r = await checkCoins(coins, { ...o.lookups, index, woc });
      return r.spent.length ? withoutOwnSpenders(r, await ownUnfinished(r.spent.map((c) => c.spender))) : r;
    },
    isLocal: () => m.isActiveStorageProvider(),
    markSpent: async (spent) => {
      const n = await m.runAsStorageProvider(async (sp) => {
        const user = (await sp.findUsers({ partial: { identityKey: o.identityKey } }))[0];
        if (!user) return 0;
        let changed = 0;
        for (const c of spent) {
          const [txid, vout] = c.outpoint.split('_');
          // spentBy only when storage holds the spender (e.g. pulled from the other device); the txid is kept below.
          const by = (
            await sp.findTransactions({ partial: { userId: user.userId, txid: c.spender }, noRawTx: true })
          )[0];
          for (const row of await sp.findOutputs({
            partial: { userId: user.userId, txid, vout: Number(vout), spendable: true },
            noScript: true,
          }))
            changed += await sp.updateOutput(row.outputId, { spendable: false, spentBy: by?.transactionId });
        }
        return changed;
      });
      if (o.kv)
        await recordAutoCleared(o.kv, o.identityKey, Object.fromEntries(spent.map((c) => [c.outpoint, c.spender])));
      return n;
    },
    log: o.log,
  });
}
