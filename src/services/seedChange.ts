/**
 * Recover change from my 12 words (3 Nov 2026).
 *
 * Why: the wallet-toolbox used to pick each change output's BRC-29 derivation (prefix and suffix, 16 random bytes each)
 * at random and keep it only in the storage row. When a device's storage was wiped, restored short, or lost an
 * in-memory payment, that change could not be found or spent from the 12 words. That stranded 28.667 BSV of the owner's
 * money and a customer's 0.94 BSV.
 *
 * Since the toolbox patch (patches/@bopen-io__wallet-toolbox-client@2.14.5.patch, "bwx: deterministic change"), new
 * change is derived from the wallet's key and the transaction's own inputs:
 *   derivationPrefix = base64(first 16 bytes of HMAC-SHA256(K, "bwx-change-v1\n" + sorted input outpoints))
 *   derivationSuffix = base64(UTF-8 of the output's vout)
 *   K = BRC-42 symmetric key to self, protocol [2, 'bwx change recovery'], key 'v1' (never leaves the key deriver).
 * So any transaction this wallet made can be checked for its change with nothing but the seed: take its inputs,
 * compute the prefix, derive each output's expected script, compare.
 *
 * What a run does (read only on chain; it writes only this wallet's storage):
 *  1. Start points: every coin storage already holds whose spender it doesn't know, and the history of every address
 *     the seed derives (identity, legacy pay and ordinals, deposit addresses).
 *  2. For each coin, ask WhatsOnChain which transaction spent it (rate-limited). For each transaction found (or seen in
 *     an address's history), recompute the change it should carry and check its outputs.
 *  3. Walk forward: each change output found is looked up in turn, until it is unspent (then it is claimed) or the
 *     depth or time limit is reached. Progress is saved after every few steps, so a later run carries on.
 *  4. Claim: a mined, unspent change output storage holds no row for is added through the toolbox's normal
 *     internalizeAction path as a 'wallet payment' with its derivation. Nothing is broadcast. A row storage already
 *     holds is never edited here (the other repair tools own those).
 * It cannot find change made with the old random derivation (before the patch): that never touched the seed.
 *
 * Which change is deterministic (review 07b, M1): the wallet's own calls (originator undefined, or the admin originator
 * registered with registerWalletOriginator), and any call whose inputs the wallet picks itself (no explicit inputs, no
 * noSendChange). A site that names inputs gets random change, so it can't replay a past payment's inputs and read its
 * change script back out of a signable transaction. Wallet-funded store, seal and send payments stay recoverable.
 *
 * A scan always finishes and never starves (reviews M2 and liveness):
 *  - start points are read again every run, and seed addresses are read before any coin is looked up;
 *  - an "unspent" answer is reused within a scan; once the walk has drained, answers older than recheckMs are asked
 *    again in one pass per scan (claims re-check before writing, so an old answer never adds a spent coin);
 *  - an item that fails maxTries runs is given up on and reported; a scan "expires" after maxRuns runs or maxAgeMs,
 *    which only gives those items another chance: queues, spends and examined transactions are kept;
 *  - a finished scan's next tap starts a new scan that keeps the spends WhatsOnChain reported mined;
 *  - "Start fresh" throws everything away.
 * Runs are per account, WhatsOnChain calls time out, and the claims fit inside the run's time budget. It refuses to run
 * while the remote store is the active one (review L1).
 */
import { Hash, P2PKH, Transaction, Utils } from '@bsv/sdk';
import { Wallet } from '@bsv/wallet-toolbox-client';
import { brc29Script, type TxidRecoverDeps } from './recoverByTxid';

const TXID = /^[0-9a-f]{64}$/;
const OUTPOINT = /^[0-9a-f]{64}\.(?:0|[1-9]\d{0,9})$/;

/** The toolbox patch's derivation, read from the patched Wallet class (one copy of the formula). */
type ChangeStatics = {
  bwxChangePrefix: (kd: unknown, outpoints: string[]) => string | undefined;
  bwxChangeSuffix: (vout: number) => string;
};
function statics(): ChangeStatics {
  const W = Wallet as unknown as Partial<ChangeStatics>;
  if (typeof W.bwxChangePrefix !== 'function' || typeof W.bwxChangeSuffix !== 'function')
    throw new Error('this build has no deterministic change (toolbox patch missing)');
  return W as ChangeStatics;
}

export type SeedKeyDeriver = TxidRecoverDeps['keyDeriver'] & {
  deriveSymmetricKey: (protocolID: [0 | 1 | 2, string], keyID: string, counterparty: string) => unknown;
};

/** The change derivation for one output of a transaction with these inputs ("txid.vout"). */
export function changeDerivation(
  kd: SeedKeyDeriver,
  inputOutpoints: string[],
  vout: number,
): { derivationPrefix: string; derivationSuffix: string } | undefined {
  const s = statics();
  const derivationPrefix = s.bwxChangePrefix(kd, inputOutpoints);
  return derivationPrefix ? { derivationPrefix, derivationSuffix: s.bwxChangeSuffix(vout) } : undefined;
}

export type FoundChange = { vout: number; satoshis: number; derivationPrefix: string; derivationSuffix: string };

/** Every output of tx that is this wallet's deterministic change (empty for anyone else's transaction). */
export function deterministicChangeOf(kd: SeedKeyDeriver, tx: Transaction): FoundChange[] {
  const inputs = tx.inputs.map((i) => `${(i.sourceTXID ?? '').toLowerCase()}.${i.sourceOutputIndex}`);
  const s = statics();
  const derivationPrefix = s.bwxChangePrefix(kd, inputs);
  if (!derivationPrefix) return [];
  const out: FoundChange[] = [];
  tx.outputs.forEach((o, vout) => {
    const script = o.lockingScript.toHex();
    // P2PKH only (76a914 <20 bytes> 88ac): skip the derivation for anything else.
    if (script.length !== 50 || !script.startsWith('76a914') || !script.endsWith('88ac')) return;
    const derivationSuffix = s.bwxChangeSuffix(vout);
    if (brc29Script(kd, { derivationPrefix, derivationSuffix }) === script)
      out.push({ vout, satoshis: o.satoshis ?? 0, derivationPrefix, derivationSuffix });
  });
  return out;
}

/** Mark an originator as the wallet itself: its calls may name inputs and still get deterministic change (sweeps). */
export function registerWalletOriginator(originator: string): void {
  const W = Wallet as unknown as { bwxWalletOriginators?: Set<string> };
  W.bwxWalletOriginators?.add(originator);
}

/** A spend answer; confirmed = WhatsOnChain says the spending transaction is mined (such answers never change). */
export type SpendState =
  | { state: 'unspent' }
  | { state: 'spent'; by: string; confirmed?: boolean }
  | { state: 'unclear' };

type F = (url: string, init?: RequestInit) => Promise<Response>;

type WocOptions = {
  fetch?: F;
  network?: 'main' | 'test';
  minIntervalMs?: number;
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Calls to anonymous WhatsOnChain (about 3 a second): spaced by minIntervalMs, each abandoned after timeoutMs even if
 * the fetch ignores its abort signal. Shared by the spend and history clients below.
 */
function wocPacing(o: WocOptions) {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const gap = o.minIntervalMs ?? 350;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let next = 0;
  let chain = Promise.resolve();
  const slot = () => {
    const mine = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await sleep(wait);
      next = Date.now() + gap;
    });
    chain = mine.catch(() => undefined);
    return mine;
  };
  const timed = async (url: string): Promise<Response> => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        f(url, { credentials: 'omit', signal: ctl?.signal }),
        new Promise<never>((_, no) => {
          timer = setTimeout(() => {
            ctl?.abort();
            no(new Error(`WhatsOnChain did not answer in ${Math.round(timeoutMs / 1000)} s`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return { slot, timed, sleep, net: o.network ?? 'main', attempts: o.attempts ?? 4 };
}

/**
 * WhatsOnChain's spender for an outpoint ("txid.vout"): GET /tx/<txid>/<vout>/spent, 404 = unspent (the route the wallet
 * already uses, services/unsentExpiry.ts). Calls are spaced (anonymous WhatsOnChain allows about 3 a second), each has a
 * timeout, and a 429, 5xx, timeout or network error is retried with growing waits. Anything still unclear is reported
 * as unclear, never as spent or unspent.
 */
export function wocSpentLookup(o: WocOptions = {}): (outpoint: string) => Promise<SpendState> {
  const { slot, timed, sleep, net, attempts } = wocPacing(o);
  return async (outpoint) => {
    if (!OUTPOINT.test(outpoint)) return { state: 'unclear' };
    const [txid, vout] = outpoint.split('.');
    for (let i = 0; i < attempts; i++) {
      await slot();
      try {
        const r = await timed(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${txid}/${vout}/spent`);
        if (r.status === 404) return { state: 'unspent' };
        if (r.status === 429 || r.status >= 500) {
          await sleep(Math.min(8000, 1000 * 2 ** i));
          continue;
        }
        if (!r.ok) return { state: 'unclear' };
        const j = (await r.json()) as { txid?: unknown; status?: unknown };
        return typeof j.txid === 'string' && TXID.test(j.txid.toLowerCase())
          ? { state: 'spent', by: j.txid.toLowerCase(), confirmed: j.status === 'confirmed' }
          : { state: 'unclear' };
      } catch {
        await sleep(Math.min(8000, 1000 * 2 ** i));
      }
    }
    return { state: 'unclear' };
  };
}

/** WhatsOnChain's script hash for a locking script: sha256 of the script's bytes, byte-reversed, as hex. */
export const wocScriptHash = (scriptHex: string): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(scriptHex, 'hex')).reverse());

/**
 * Every transaction that touched an address, from WhatsOnChain's script history (release click-through, 4 Nov 2026,
 * F-B). The toolbox's getScriptHashHistory reported WhatsOnChain's 404 for an address with no history as an error, so
 * every unused seed address read as "the network was busy" and was given up after 3 runs; and it read only the first
 * page, while WhatsOnChain returns confirmed history 100 entries a page.
 *  - 404 on the FIRST page of the history call = the address has no history: an empty list. Any other 404 (a later
 *    page) is unclear.
 *  - Every page is read, following nextPageToken (?token=…), confirmed and unconfirmed history alike, up to maxPages
 *    each; a longer history is unclear, never a silently cut list.
 *  - 429, 5xx, timeouts and network errors are retried with growing waits; an answer that is still unclear, a non-empty
 *    `error` or a body that isn't a history page gives undefined (unclear), never "no history".
 */
export function wocAddressHistory(
  o: WocOptions & { maxPages?: number } = {},
): (address: string) => Promise<string[] | undefined> {
  const { slot, timed, sleep, net, attempts } = wocPacing(o);
  const maxPages = o.maxPages ?? 200;
  type Page = { items: unknown[]; next?: string } | 'none' | undefined;
  const page = async (url: string, first: boolean): Promise<Page> => {
    for (let i = 0; i < attempts; i++) {
      await slot();
      try {
        const r = await timed(url);
        if (r.status === 404) return first ? 'none' : undefined;
        if (r.status === 429 || r.status >= 500) {
          await sleep(Math.min(8000, 1000 * 2 ** i));
          continue;
        }
        if (!r.ok) return undefined;
        const j = (await r.json()) as { result?: unknown; nextPageToken?: unknown; error?: unknown };
        if (!j || !Array.isArray(j.result) || (typeof j.error === 'string' && j.error !== '')) return undefined;
        const next = typeof j.nextPageToken === 'string' && j.nextPageToken !== '' ? j.nextPageToken : undefined;
        return { items: j.result, next };
      } catch {
        await sleep(Math.min(8000, 1000 * 2 ** i));
      }
    }
    return undefined;
  };
  const history = async (hash: string, kind: 'confirmed' | 'unconfirmed'): Promise<string[] | undefined> => {
    const base = `https://api.whatsonchain.com/v1/bsv/${net}/script/${hash}/${kind}/history`;
    const out: string[] = [];
    let token: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      const p = await page(token ? `${base}?token=${encodeURIComponent(token)}` : base, n === 0);
      if (p === 'none') return out;
      if (!p) return undefined;
      for (const it of p.items) {
        const txid = String((it as { tx_hash?: unknown })?.tx_hash ?? '').toLowerCase();
        if (TXID.test(txid)) out.push(txid);
      }
      if (!p.next) return out;
      token = p.next;
    }
    return undefined;
  };
  return async (address) => {
    const script = p2pkhHex(address);
    if (!script) return [];
    const hash = wocScriptHash(script);
    const confirmed = await history(hash, 'confirmed');
    if (!confirmed) return undefined;
    const unconfirmed = await history(hash, 'unconfirmed');
    if (!unconfirmed) return undefined;
    return [...new Set([...confirmed, ...unconfirmed])];
  };
}

/** What the walk found for one change output. */
export type FoundEntry = {
  txid: string;
  vout: number;
  satoshis: number;
  /**
   * unspent: found, not added yet. spent: the chain (or storage) names a spender, so the walk goes on from there.
   * restored: added this scan. already: storage already holds it as spendable. held: storage holds a row for it that
   * this tool leaves alone. pending: its transaction isn't mined yet. failed: adding it failed (tried again next run).
   */
  state: 'unspent' | 'spent' | 'restored' | 'already' | 'held' | 'pending' | 'failed';
  detail?: string;
};

/** Work the walk could not finish (network busy, not served yet); tried again next run, up to maxTries runs. */
type Retry = { kind: 'tx' | 'outpoint' | 'address'; id: string; depth: number; tries: number };

/** Saved between runs (no keys or derivations: only public outpoints, txids and amounts). */
export type SeedChangeState = {
  v: 3;
  startedAt: number;
  updatedAt: number;
  /** Runs since the scan began or last expired; expiry only gives items given up on another chance. */
  runs: number;
  done: boolean;
  /** This scan's one pass re-asking stale "unspent" answers has been made (it runs once the walk has drained). */
  rechecked: boolean;
  /** Seed addresses whose history is still to be read (a queue; each is read once per scan). */
  addresses: string[];
  /** Seed addresses read in this scan, and when (the recheck pass reads those older than recheckMs again). */
  addressesRead: [string, number][];
  /** Transactions to examine, with their walk depth. */
  txs: [string, number][];
  /** Outpoints whose spender is still to be looked up, with their depth. */
  outpoints: [string, number][];
  examined: string[];
  /** Spender per outpoint ('' = unspent). */
  spends: [string, string][];
  /** When each "unspent" answer was given (the recheck pass re-asks those older than recheckMs). */
  unspentAt: [string, number][];
  /** Outpoints whose spend WhatsOnChain reported mined: kept into the next scan, so a re-scan needn't ask again. */
  confirmed: string[];
  retry: Retry[];
  /** Items that failed maxTries runs: skipped until the scan expires or Start fresh. */
  gaveUp: Retry[];
  found: FoundEntry[];
  tooDeep: number;
  stats: { lookups: number; txs: number; addresses: number };
};

export type SeedChangeKV = { load: () => Promise<SeedChangeState | null>; save: (s: SeedChangeState) => Promise<void> };

/** The claim's verdict per output (services/seedChangeWiring.ts: the toolbox's internalize path). */
export type ClaimResult = { vout: number; state: FoundEntry['state']; detail?: string }[];

export type SeedChangeDeps = {
  keyDeriver: SeedKeyDeriver;
  /**
   * Start points from storage, read on every run. open: outputs whose spender is looked up on chain. settled: outputs
   * storage holds as spent by a completed (mined) payment of its own, with that payment's txid. The walk takes the
   * spender from storage (no network call) and still examines it, so change rows missing from storage, all or some, are
   * found (review L2).
   */
  storageOutpoints: () => Promise<{ open: string[]; settled: [string, string][] }>;
  /** Addresses the seed derives (each history is read once per scan, ahead of coins up to 30% of a run). */
  seedAddresses: () => Promise<string[]>;
  /** Txids in an address's history (funding and spending); undefined when it couldn't be read. */
  addressHistory: (address: string) => Promise<string[] | undefined>;
  spentBy: (outpoint: string) => Promise<SpendState>;
  getRawTx: (txid: string) => Promise<number[] | undefined>;
  /** Add unspent change of one mined transaction to storage (never broadcasts; re-checks unspent first). */
  claim: (txid: string, change: FoundChange[]) => Promise<ClaimResult>;
  /** Push to backups once at the end when something was added. */
  pushBackups?: () => Promise<unknown>;
  /** A reason not to run at all (e.g. the remote store is still the active one), or undefined. */
  refusal?: () => string | undefined;
  /** Throw the saved scan away, confirmed spends included, and start again ("Start fresh"). */
  fresh?: boolean;
  kv: SeedChangeKV;
  progress?: (step: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Per-run time budget, claims included (default 4 min). */
  runMs?: number;
  /** Walk depth limit (default 10 000 hops) and transactions per scan (default 20 000). */
  maxDepth?: number;
  maxTxs?: number;
  /** Runs an item may fail before it is given up on (default 3). */
  maxTries?: number;
  /**
   * After this many runs (default 20) or this age (default 2 days) a scan expires: items given up on get another chance.
   * Walk progress (queues, spends, examined transactions, found change) is always kept.
   */
  maxRuns?: number;
  maxAgeMs?: number;
  /**
   * Once the walk has drained, "unspent" answers older than this (default 10 min) are asked again, once per scan: the
   * coin may have been spent, and that payment lost, since. Claims re-check before writing, so a stale answer never adds
   * a spent coin; it only delays finding a later loss until the end of the walk.
   */
  recheckMs?: number;
};

export type SeedChangeReport = {
  /** The whole walk finished (nothing queued or waiting to retry). The next run starts a new scan. */
  done: boolean;
  /** This run stopped at its time budget; the next run carries on from the saved state. */
  paused: boolean;
  restoredSats: number;
  restored: number;
  alreadySats: number;
  pendingSats: number;
  heldSats: number;
  failed: number;
  /** Items waiting to be tried again next run. */
  retry: number;
  /** Items skipped after maxTries failed runs. */
  gaveUp: number;
  tooDeep: number;
  examined: number;
  lookups: number;
  runs: number;
  error?: string;
};

const fresh = (now: number): SeedChangeState => ({
  v: 3,
  startedAt: now,
  updatedAt: now,
  runs: 0,
  done: false,
  rechecked: false,
  addresses: [],
  addressesRead: [],
  txs: [],
  outpoints: [],
  examined: [],
  spends: [],
  unspentAt: [],
  confirmed: [],
  retry: [],
  gaveUp: [],
  found: [],
  tooDeep: 0,
  stats: { lookups: 0, txs: 0, addresses: 0 },
});

/**
 * The state this run starts from.
 * - Start fresh, nothing saved, or an older format: a new scan.
 * - The last scan finished: a new scan that keeps only the spends WhatsOnChain reported mined (they never change).
 * - The scan expired (maxRuns runs or maxAgeMs): the same scan, with items given up on queued again. Nothing else is
 *   reset, so a long walk never loses its progress.
 * - Otherwise: carry on.
 */
function startState(
  loaded: SeedChangeState | null,
  deps: SeedChangeDeps,
  t0: number,
  maxRuns: number,
  maxAgeMs: number,
) {
  if (deps.fresh || !loaded || loaded.v !== 3 || !Array.isArray(loaded.addressesRead)) return fresh(t0);
  if (loaded.done) {
    const s = fresh(t0);
    const confirmed = new Set(loaded.confirmed);
    s.spends = loaded.spends.filter(([o, by]) => by !== '' && confirmed.has(o));
    s.confirmed = s.spends.map(([o]) => o);
    return s;
  }
  if (loaded.runs >= maxRuns || t0 - loaded.startedAt > maxAgeMs) {
    for (const r of loaded.gaveUp.splice(0)) loaded.retry.push({ ...r, tries: 0 });
    loaded.runs = 0;
    loaded.startedAt = t0;
  }
  return loaded;
}

const bsv = (sats: number) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');

/** One run at a time per account; a second tap on the same account joins the run in flight. */
const running = new Map<string, Promise<SeedChangeReport>>();

export function recoverSeedChange(deps: SeedChangeDeps): Promise<SeedChangeReport> {
  const account = deps.keyDeriver.identityKey;
  const inFlight = running.get(account);
  if (inFlight) return inFlight;
  const run = runOnce(deps).finally(() => {
    running.delete(account);
  });
  running.set(account, run);
  return run;
}

const CLAIMABLE: FoundEntry['state'][] = ['unspent', 'pending', 'failed'];

async function runOnce(deps: SeedChangeDeps): Promise<SeedChangeReport> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const progress = deps.progress ?? (() => undefined);
  const t0 = now();
  const runMs = deps.runMs ?? 240_000;
  // The walk stops at 80% of the budget so the claims fit inside it (the extension worker is killed at 5 min).
  const walkMs = Math.floor(runMs * 0.8);
  const maxDepth = deps.maxDepth ?? 10_000;
  const maxTxs = deps.maxTxs ?? 20_000;
  const maxTries = deps.maxTries ?? 3;
  const maxRuns = deps.maxRuns ?? 20;
  const maxAgeMs = deps.maxAgeMs ?? 2 * 24 * 3600_000;
  const recheckMs = deps.recheckMs ?? 10 * 60_000;
  // Address histories may use at most this much of a run while coins are waiting (review 07c F1).
  const addressMs = Math.floor(walkMs * 0.3);

  const refused = deps.refusal?.();
  if (refused) return { ...emptyReport(), error: refused };

  const s = startState(await deps.kv.load().catch(() => null), deps, t0, maxRuns, maxAgeMs);
  s.runs++;
  const examined = new Set(s.examined);
  const spends = new Map(s.spends);
  const unspentAt = new Map(s.unspentAt);
  const confirmed = new Set(s.confirmed);
  const addressesRead = new Map(s.addressesRead);
  const key = (txid: string, vout: number) => `${txid}.${vout}`;
  const found = new Map(s.found.map((f) => [key(f.txid, f.vout), f]));
  const tag = (kind: Retry['kind'], id: string) => `${kind}:${id}`;
  const gaveUp = new Set(s.gaveUp.map((r) => tag(r.kind, r.id)));
  const tries = new Map(s.retry.map((r) => [tag(r.kind, r.id), r.tries]));
  const fail = (kind: Retry['kind'], id: string, depth: number) => {
    const n = (tries.get(tag(kind, id)) ?? 0) + 1;
    tries.set(tag(kind, id), n);
    if (n >= maxTries) {
      s.gaveUp.push({ kind, id, depth, tries: n });
      gaveUp.add(tag(kind, id));
      log(`[seedChange] gave up on ${kind} ${id} after ${n} tries`);
    } else s.retry.push({ kind, id, depth, tries: n });
  };

  const save = async () => {
    s.examined = [...examined];
    s.spends = [...spends];
    s.unspentAt = [...unspentAt].filter(([o]) => spends.get(o) === '');
    s.confirmed = [...confirmed].filter((o) => !!spends.get(o));
    s.addressesRead = [...addressesRead];
    s.found = [...found.values()];
    s.updatedAt = now();
    await deps.kv.save(s).catch((e) => log(`[seedChange] saving progress failed: ${String(e)}`));
  };
  const say = () => {
    const total = [...found.values()]
      .filter((f) => f.state === 'unspent' || f.state === 'restored')
      .reduce((n, f) => n + f.satoshis, 0);
    progress(
      `Checked ${s.stats.lookups} coins and ${s.stats.txs} payments${total ? `, found ${bsv(total)} BSV` : ''}…`,
    );
  };
  const tally = (): SeedChangeReport => {
    const all = [...found.values()];
    const sum = (k: FoundEntry['state']) => all.filter((f) => f.state === k).reduce((t, f) => t + f.satoshis, 0);
    return {
      done: s.done,
      paused: false,
      restoredSats: sum('restored'),
      restored: all.filter((f) => f.state === 'restored').length,
      alreadySats: sum('already'),
      pendingSats: sum('pending'),
      heldSats: sum('held'),
      failed: all.filter((f) => f.state === 'failed').length,
      retry: s.retry.length,
      gaveUp: s.gaveUp.length,
      tooDeep: s.tooDeep,
      examined: s.stats.txs,
      lookups: s.stats.lookups,
      runs: s.runs,
    };
  };

  try {
    // 1. Unfinished work from the last run goes back in its queue first.
    for (const r of s.retry.splice(0)) {
      if (r.kind === 'tx') s.txs.push([r.id, r.depth]);
      else if (r.kind === 'outpoint') s.outpoints.push([r.id, r.depth]);
      else s.addresses.push(r.id);
    }
    // 2. Start points, read again on every run: storage changes (a coin restored in an earlier run may have been
    //    spent and lost again since), and so do the seed addresses' histories.
    progress('Reading this wallet’s records…');
    const fromStorage = await deps.storageOutpoints();
    const settled = new Map(fromStorage.settled);
    const queued = new Set(s.outpoints.map(([o]) => o));
    const openStarts: [string, number][] = [];
    const settledStarts: [string, number][] = [];
    const enqueue = (o: string, into: [string, number][], depth = 0) => {
      if (!OUTPOINT.test(o) || queued.has(o) || gaveUp.has(tag('outpoint', o))) return;
      const by = spends.get(o);
      if (by === '' || (by && examined.has(by))) return; // answered and followed already
      queued.add(o);
      into.push([o, depth]);
    };
    for (const o of fromStorage.open) enqueue(o, openStarts);
    // Change found earlier and not yet in the wallet whose spend isn't known: look it up.
    for (const f of found.values()) if (CLAIMABLE.includes(f.state)) enqueue(key(f.txid, f.vout), openStarts);
    for (const [o] of fromStorage.settled) enqueue(o, settledStarts);
    // The stack pops from the end: the walk in progress carries on first, then open coins (where losses are), and only
    // then storage's settled history, so the transaction cap can't use itself up before an open coin (review 07c F2).
    s.outpoints = [...settledStarts, ...openStarts, ...s.outpoints];
    progress('Listing the addresses your 12 words make…');
    const seedScripts = new Set<string>();
    for (const a of new Set(await deps.seedAddresses())) {
      const script = p2pkhHex(a);
      if (script) seedScripts.add(script);
      // Once per scan (review 07c F1): re-reading every address every run could leave no time for any coin.
      if (!addressesRead.has(a) && !s.addresses.includes(a) && !gaveUp.has(tag('address', a))) s.addresses.push(a);
    }
    await save();

    let steps = 0;
    let addressSpent = 0;
    while (now() - t0 < walkMs) {
      if (++steps % 20 === 0) {
        await save();
        say();
      }
      // a. Examine a transaction: does it carry this wallet's change, or pay a seed address?
      const t = s.txs.pop();
      if (t) {
        const [txid, depth] = t;
        if (examined.has(txid) || gaveUp.has(tag('tx', txid))) continue;
        if (examined.size >= maxTxs) {
          s.tooDeep++;
          continue;
        }
        const raw = await deps.getRawTx(txid).catch(() => undefined);
        let tx: Transaction | undefined;
        try {
          tx = raw?.length ? Transaction.fromBinary(raw) : undefined;
        } catch {
          tx = undefined;
        }
        if (!tx || tx.id('hex') !== txid) {
          fail('tx', txid, depth); // not served yet, busy, or a bad answer: try again next run
          continue;
        }
        examined.add(txid);
        s.stats.txs++;
        if (depth + 1 > maxDepth) {
          s.tooDeep++;
          continue;
        }
        for (const c of deterministicChangeOf(deps.keyDeriver, tx)) {
          const k = key(txid, c.vout);
          const f = found.get(k) ?? { txid, vout: c.vout, satoshis: c.satoshis, state: 'unspent' };
          found.set(k, f);
          if (spends.get(k) && CLAIMABLE.includes(f.state)) f.state = 'spent';
          enqueue(k, s.outpoints, depth + 1); // depth first: the walk reaches the unspent tail sooner
        }
        // A coin paid to a seed address: whoever spent it may have made this wallet's change.
        tx.outputs.forEach((out, vout) => {
          if (seedScripts.has(out.lockingScript.toHex())) enqueue(key(txid, vout), s.outpoints, depth + 1);
        });
        continue;
      }
      // b. Read one seed address's history, in queue order. Addresses come before coins, up to addressMs of the run
      //    while coins are waiting, so neither can starve the other (reviews 03261054 and 07c F1).
      if (s.addresses.length && (addressSpent < addressMs || !s.outpoints.length)) {
        const a = s.addresses.shift()!;
        progress(`Reading the history of ${a.slice(0, 8)}…`);
        const before = now();
        const h = await deps.addressHistory(a).catch(() => undefined);
        addressSpent += now() - before;
        s.stats.addresses++;
        if (!h) {
          fail('address', a, 0);
          continue;
        }
        addressesRead.set(a, now());
        for (const txid of new Set(h)) if (TXID.test(txid) && !examined.has(txid)) s.txs.push([txid, 0]);
        continue;
      }
      // c. Find who spent a coin: storage's own record of a settled payment, a spend known already, or WhatsOnChain.
      const o = s.outpoints.pop();
      if (o) {
        const [outpoint, depth] = o;
        queued.delete(outpoint);
        let by = spends.get(outpoint);
        if (by === '') continue;
        if (by === undefined && settled.has(outpoint)) {
          by = settled.get(outpoint)!;
          spends.set(outpoint, by);
        }
        if (by === undefined) {
          const r = await deps.spentBy(outpoint).catch((): SpendState => ({ state: 'unclear' }));
          s.stats.lookups++;
          if (r.state === 'unclear') {
            fail('outpoint', outpoint, depth);
            continue;
          }
          if (r.state === 'unspent') {
            spends.set(outpoint, '');
            unspentAt.set(outpoint, now());
            continue;
          }
          by = r.by;
          spends.set(outpoint, by);
          if (r.confirmed) confirmed.add(outpoint);
        }
        const f = found.get(outpoint);
        if (f && CLAIMABLE.includes(f.state)) f.state = 'spent';
        if (!examined.has(by)) s.txs.push([by, depth]);
        continue;
      }
      // d. The walk has drained. Once per scan, ask again about coins first seen unspent long enough ago that they may
      //    have been spent (and that payment lost) since, and read again addresses read that long ago; then carry on
      //    walking from what that finds.
      if (!s.rechecked) {
        const cutoff = now() - recheckMs;
        const stale = [...spends].filter(([o, v]) => v === '' && (unspentAt.get(o) ?? 0) < cutoff).map(([o]) => o);
        const staleAddresses = [...addressesRead].filter(([, at]) => at < cutoff).map(([a]) => a);
        if (stale.length || staleAddresses.length) {
          s.rechecked = true;
          progress(`Checking ${stale.length} coins again…`);
          for (const so of stale) {
            spends.delete(so);
            unspentAt.delete(so);
            enqueue(so, s.outpoints);
          }
          for (const sa of staleAddresses) {
            addressesRead.delete(sa);
            s.addresses.push(sa);
          }
          continue;
        }
      }
      break;
    }
    const walkDone = !s.txs.length && !s.outpoints.length && !s.addresses.length && !s.retry.length;

    // 3. Claim change found unspent (and any an earlier run couldn't add), inside the run's budget. The claim asks the
    //    chain again before it writes anything, so an older "unspent" answer can't add a spent coin.
    const byTx = new Map<string, FoundEntry[]>();
    for (const f of found.values())
      if (CLAIMABLE.includes(f.state) && spends.get(key(f.txid, f.vout)) === '')
        byTx.set(f.txid, [...(byTx.get(f.txid) ?? []), f]);
    let restoredNow = 0;
    let claimsLeft = false;
    let n = 0;
    for (const [txid, entries] of byTx) {
      if (now() - t0 >= runMs) {
        claimsLeft = true; // carried over to the next run
        break;
      }
      progress(`Adding change ${++n} of ${byTx.size}…`);
      try {
        const raw = await deps.getRawTx(txid);
        const tx = raw?.length ? Transaction.fromBinary(raw) : undefined;
        const change =
          tx && tx.id('hex') === txid
            ? deterministicChangeOf(deps.keyDeriver, tx).filter((c) => entries.some((e) => e.vout === c.vout))
            : [];
        if (!change.length) throw new Error('the transaction couldn’t be fetched');
        const results = await deps.claim(txid, change);
        for (const e of entries) {
          const r = results.find((x) => x.vout === e.vout);
          if (!r) continue;
          e.state = r.state;
          e.detail = r.detail;
          if (r.state === 'restored') restoredNow += e.satoshis;
          if (r.state === 'spent') {
            // Spent since it was looked up: follow the new spender on the next run.
            const k = key(e.txid, e.vout);
            spends.delete(k);
            unspentAt.delete(k);
            s.retry.push({ kind: 'outpoint', id: k, depth: 0, tries: 0 });
          }
        }
      } catch (err) {
        for (const e of entries) {
          e.state = 'failed';
          e.detail = err instanceof Error ? err.message : String(err);
        }
      }
      await save(); // checkpoint after every claim
    }
    if (restoredNow > 0 && deps.pushBackups) {
      progress('Saving to your backup…');
      await deps.pushBackups().catch((e) => log(`[seedChange] backup push failed: ${String(e)}`));
    }

    s.done = walkDone && !s.retry.length && !claimsLeft;
    await save();
    const report = { ...tally(), paused: !s.done && (now() - t0 >= walkMs || claimsLeft) };
    log(
      `[seedChange] run ${s.runs}, ${now() - t0} ms: ${report.examined} txs, ${report.lookups} lookups, restored ${report.restoredSats} sats${report.paused ? ' (paused)' : ''}`,
    );
    return report;
  } catch (e) {
    await save();
    return { ...tally(), done: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const emptyReport = (): SeedChangeReport => ({
  done: false,
  paused: false,
  restoredSats: 0,
  restored: 0,
  alreadySats: 0,
  pendingSats: 0,
  heldSats: 0,
  failed: 0,
  retry: 0,
  gaveUp: 0,
  tooDeep: 0,
  examined: 0,
  lookups: 0,
  runs: 0,
});

/** The P2PKH script hex of an address ('' when it isn't one). */
export const p2pkhHex = (address: string): string => {
  try {
    return new P2PKH().lock(address).toHex();
  } catch {
    return '';
  }
};

/** One line for Settings › Troubleshooting. */
export function seedChangeSummary(r: SeedChangeReport): string {
  if (r.error) return `Couldn’t run: ${r.error}`;
  const parts: string[] = [];
  if (r.restoredSats > 0)
    parts.push(`Found ${bsv(r.restoredSats)} BSV of change from your 12 words and added it to your wallet.`);
  if (r.pendingSats > 0)
    parts.push(`${bsv(r.pendingSats)} BSV is in a payment still waiting for a block; tap again after it confirms.`);
  if (r.heldSats > 0)
    parts.push(`${bsv(r.heldSats)} BSV is held by this wallet’s own records (Find mined payments can check it).`);
  if (r.failed > 0) parts.push(`${r.failed} coin${r.failed === 1 ? '' : 's'} couldn’t be added; tap again to retry.`);
  if (r.paused)
    parts.push(
      `Paused: checked ${r.lookups} coins and ${r.examined} payments so far. Tap again to carry on where it stopped.`,
    );
  else if (r.retry > 0)
    parts.push(`${r.retry} lookups got no clear answer (the network was busy); tap again to retry them.`);
  if (r.gaveUp > 0)
    parts.push(
      `${r.gaveUp} item${r.gaveUp === 1 ? '' : 's'} couldn’t be checked after several tries and ${r.gaveUp === 1 ? 'was' : 'were'} skipped; Start fresh tries again.`,
    );
  if (r.tooDeep > 0)
    parts.push(
      `Stopped at this scan’s limit: ${r.tooDeep} more payment${r.tooDeep === 1 ? ' was' : 's were'} not checked, so some change may still be missing.`,
    );
  if (!parts.length)
    parts.push(
      r.alreadySats > 0
        ? `Checked ${r.examined} payments: all the change your 12 words can find is already in your wallet.`
        : `Checked ${r.examined} payments: no missing change found.`,
    );
  parts.push('Change from payments made before this update can’t be found this way.');
  return parts.join(' ');
}
