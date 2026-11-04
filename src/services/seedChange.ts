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
 * A scan never gets stuck (review M2): start points are read again every run, an "unspent" answer older than recheckMs
 * is asked again, an item that fails maxTries runs is given up on (and reported), a scan expires after maxRuns runs or
 * maxAgeMs, and "Start fresh" throws the saved scan away. Runs are per account, WhatsOnChain calls time out, and the
 * claims fit inside the run's time budget. It refuses to run while the remote store is the active one (review L1).
 */
import { P2PKH, Transaction } from '@bsv/sdk';
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

export type SpendState = { state: 'unspent' } | { state: 'spent'; by: string } | { state: 'unclear' };

type F = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * WhatsOnChain's spender for an outpoint ("txid.vout"): GET /tx/<txid>/<vout>/spent, 404 = unspent (the route the wallet
 * already uses, services/unsentExpiry.ts). Calls are spaced (anonymous WhatsOnChain allows about 3 a second), each has a
 * timeout, and a 429, 5xx, timeout or network error is retried with growing waits. Anything still unclear is reported
 * as unclear, never as spent or unspent.
 */
export function wocSpentLookup(
  o: {
    fetch?: F;
    network?: 'main' | 'test';
    minIntervalMs?: number;
    attempts?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): (outpoint: string) => Promise<SpendState> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const net = o.network ?? 'main';
  const gap = o.minIntervalMs ?? 350;
  const attempts = o.attempts ?? 4;
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
  /** One request, abandoned after timeoutMs even if the fetch ignores its abort signal. */
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
        const j = (await r.json()) as { txid?: unknown };
        return typeof j.txid === 'string' && TXID.test(j.txid.toLowerCase())
          ? { state: 'spent', by: j.txid.toLowerCase() }
          : { state: 'unclear' };
      } catch {
        await sleep(Math.min(8000, 1000 * 2 ** i));
      }
    }
    return { state: 'unclear' };
  };
}

/** What the walk found for one change output. */
export type FoundEntry = {
  txid: string;
  vout: number;
  satoshis: number;
  /**
   * unspent: found, not added yet. spent: the chain names a spender, so the walk goes on from there.
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
  v: 2;
  startedAt: number;
  updatedAt: number;
  /** Runs of this scan so far; a scan older than maxRuns runs or maxAgeMs starts fresh. */
  runs: number;
  done: boolean;
  /** Seed addresses whose history is still to be read this run. */
  addresses: string[];
  /** Transactions to examine, with their walk depth. */
  txs: [string, number][];
  /** Outpoints whose spender is still to be looked up, with their depth. */
  outpoints: [string, number][];
  examined: string[];
  /** Spender per outpoint looked up ('' = unspent). */
  spends: [string, string][];
  /** When each "unspent" answer was given: older than recheckMs at the start of a run, it is asked again. */
  unspentAt: [string, number][];
  retry: Retry[];
  /** Items that failed maxTries runs in a row: skipped for the rest of this scan (Start fresh tries them again). */
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
   * Start points from storage, read on every run. open: outputs looked up on chain. settled: outputs storage holds as
   * spent by a completed or unproven payment of its own whose change rows it also holds (the walk needn't pass them).
   */
  storageOutpoints: () => Promise<{ open: string[]; settled: string[] }>;
  /** Addresses the seed derives (read on every run). */
  seedAddresses: () => Promise<string[]>;
  /** Txids in an address's history (funding and spending); undefined when it couldn't be read. */
  addressHistory: (address: string) => Promise<string[] | undefined>;
  spentBy: (outpoint: string) => Promise<SpendState>;
  getRawTx: (txid: string) => Promise<number[] | undefined>;
  /** Add unspent change of one mined transaction to storage (never broadcasts). */
  claim: (txid: string, change: FoundChange[]) => Promise<ClaimResult>;
  /** Push to backups once at the end when something was added. */
  pushBackups?: () => Promise<unknown>;
  /** A reason not to run at all (e.g. the remote store is still the active one), or undefined. */
  refusal?: () => string | undefined;
  /** Throw away the saved scan and start again ("Start fresh"). */
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
  /** A scan starts fresh after this many runs (default 20) or this age (default 2 days). */
  maxRuns?: number;
  maxAgeMs?: number;
  /**
   * An "unspent" answer older than this (default 10 min) is dropped at the start of a run and asked again: the coin may
   * have been spent (and that payment lost) since. Taps in quick succession share answers, so a wallet with more coins
   * than one run can look up still finishes its scan.
   */
  recheckMs?: number;
};

export type SeedChangeReport = {
  /** The whole walk finished (nothing queued or waiting to retry). The next run starts a fresh scan. */
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
  v: 2,
  startedAt: now,
  updatedAt: now,
  runs: 0,
  done: false,
  addresses: [],
  txs: [],
  outpoints: [],
  examined: [],
  spends: [],
  unspentAt: [],
  retry: [],
  gaveUp: [],
  found: [],
  tooDeep: 0,
  stats: { lookups: 0, txs: 0, addresses: 0 },
});

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

  const refused = deps.refusal?.();
  if (refused) return { ...emptyReport(), error: refused };

  const loaded = await deps.kv.load().catch(() => null);
  const keep =
    !deps.fresh &&
    loaded?.v === 2 &&
    !loaded.done &&
    loaded.runs < maxRuns &&
    t0 - loaded.startedAt <= maxAgeMs &&
    Array.isArray(loaded.gaveUp) &&
    Array.isArray(loaded.unspentAt);
  const s = keep ? loaded : fresh(t0);
  s.runs++;
  const examined = new Set(s.examined);
  // Spends stay known. An "unspent" answer goes stale (the coin may have been spent, and that payment lost, since it was
  // asked), so one older than recheckMs is dropped and asked again this run.
  const unspentAt = new Map(s.unspentAt.filter(([, at]) => t0 - at < recheckMs));
  const spends = new Map(s.spends.filter(([o, by]) => by !== '' || unspentAt.has(o)));
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
    const settled = new Set(fromStorage.settled);
    const queued = new Set(s.outpoints.map(([o]) => o));
    const enqueue = (o: string) => {
      if (!OUTPOINT.test(o) || settled.has(o) || spends.has(o) || queued.has(o) || gaveUp.has(tag('outpoint', o)))
        return;
      queued.add(o);
      s.outpoints.unshift([o, 0]); // under the walk in progress: deep chains carry on first
    };
    for (const o of fromStorage.open) enqueue(o);
    // Change found earlier and not yet in the wallet: ask again whether it is still unspent.
    for (const f of found.values()) if (CLAIMABLE.includes(f.state)) enqueue(key(f.txid, f.vout));
    progress('Listing the addresses your 12 words make…');
    for (const a of new Set(await deps.seedAddresses()))
      if (!s.addresses.includes(a) && !gaveUp.has(tag('address', a))) s.addresses.push(a);
    await save();

    let steps = 0;
    while (now() - t0 < walkMs) {
      if (++steps % 20 === 0) {
        await save();
        say();
      }
      // a. Examine a transaction: does it carry this wallet's change?
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
        for (const c of deterministicChangeOf(deps.keyDeriver, tx)) {
          const k = key(txid, c.vout);
          const f = found.get(k) ?? { txid, vout: c.vout, satoshis: c.satoshis, state: 'unspent' };
          found.set(k, f);
          const by = spends.get(k);
          if (by) {
            // Already known to be spent (a start point looked up earlier): its spender is queued or examined.
            if (CLAIMABLE.includes(f.state)) f.state = 'spent';
            continue;
          }
          if (settled.has(k)) {
            // Storage holds it as spent by a completed payment of its own whose change it also holds.
            if (CLAIMABLE.includes(f.state)) f.state = 'spent';
            continue;
          }
          if (queued.has(k)) continue;
          if (depth + 1 > maxDepth) {
            s.tooDeep++;
            continue;
          }
          queued.add(k);
          s.outpoints.push([k, depth + 1]); // depth first: the walk reaches the unspent tail sooner
        }
        continue;
      }
      // b. Look up who spent a coin.
      const o = s.outpoints.pop();
      if (o) {
        const [outpoint, depth] = o;
        queued.delete(outpoint);
        if (spends.has(outpoint) || settled.has(outpoint)) continue;
        const r = await deps.spentBy(outpoint).catch((): SpendState => ({ state: 'unclear' }));
        s.stats.lookups++;
        if (r.state === 'unclear') {
          fail('outpoint', outpoint, depth);
          continue;
        }
        spends.set(outpoint, r.state === 'spent' ? r.by : '');
        if (r.state === 'unspent') {
          unspentAt.set(outpoint, now());
          continue;
        }
        const f = found.get(outpoint);
        if (f && CLAIMABLE.includes(f.state)) f.state = 'spent';
        if (!examined.has(r.by)) s.txs.push([r.by, depth]);
        continue;
      }
      // c. Read one seed address's history: every transaction in it is examined.
      const a = s.addresses.pop();
      if (a) {
        progress(`Reading the history of ${a.slice(0, 8)}…`);
        const h = await deps.addressHistory(a).catch(() => undefined);
        s.stats.addresses++;
        if (!h) {
          fail('address', a, 0);
          continue;
        }
        for (const txid of new Set(h)) if (TXID.test(txid) && !examined.has(txid)) s.txs.push([txid, 0]);
        continue;
      }
      break;
    }
    const walkDone = !s.txs.length && !s.outpoints.length && !s.addresses.length && !s.retry.length;

    // 3. Claim change found unspent this run (and any an earlier run couldn't add), inside the run's budget.
    const byTx = new Map<string, FoundEntry[]>();
    for (const f of found.values())
      if (CLAIMABLE.includes(f.state) && spends.get(key(f.txid, f.vout)) === '')
        byTx.set(f.txid, [...(byTx.get(f.txid) ?? []), f]);
    let restoredNow = 0;
    let claimsLeft = false;
    let n = 0;
    for (const [txid, entries] of byTx) {
      if (now() - t0 >= runMs) {
        claimsLeft = true; // carried over: the next run asks again and claims
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
  if (!parts.length)
    parts.push(
      r.alreadySats > 0
        ? `Checked ${r.examined} payments: all the change your 12 words can find is already in your wallet.`
        : `Checked ${r.examined} payments: no missing change found.`,
    );
  parts.push('Change from payments made before this update can’t be found this way.');
  return parts.join(' ');
}
