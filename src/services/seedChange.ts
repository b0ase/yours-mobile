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

export type SpendState = { state: 'unspent' } | { state: 'spent'; by: string } | { state: 'unclear' };

type F = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * WhatsOnChain's spender for an outpoint ("txid.vout"): GET /tx/<txid>/<vout>/spent, 404 = unspent (the route the wallet
 * already uses, services/unsentExpiry.ts). Calls are spaced (anonymous WhatsOnChain allows about 3 a second) and a 429
 * or 5xx is retried with growing waits; anything still unclear is reported as unclear, never as spent or unspent.
 */
export function wocSpentLookup(
  o: {
    fetch?: F;
    network?: 'main' | 'test';
    minIntervalMs?: number;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): (outpoint: string) => Promise<SpendState> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const net = o.network ?? 'main';
  const gap = o.minIntervalMs ?? 350;
  const attempts = o.attempts ?? 4;
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
  return async (outpoint) => {
    if (!OUTPOINT.test(outpoint)) return { state: 'unclear' };
    const [txid, vout] = outpoint.split('.');
    for (let i = 0; i < attempts; i++) {
      await slot();
      try {
        const r = await f(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${txid}/${vout}/spent`, {
          credentials: 'omit',
        });
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
   * unspent: found, not added yet. spent: the chain (or storage) names a spender, so the walk goes on from there.
   * restored: added this scan. already: storage already holds it as spendable. held: storage holds a row for it that
   * this tool leaves alone. pending: its transaction isn't mined yet. failed: adding it failed (tried again next run).
   */
  state: 'unspent' | 'spent' | 'restored' | 'already' | 'held' | 'pending' | 'failed';
  detail?: string;
};

/** Work the walk could not finish this run (network busy or not served yet); queued again next run. */
type Retry = { kind: 'tx' | 'outpoint' | 'address'; id: string; depth: number };

/** Saved between runs (no keys or derivations: only public outpoints, txids and amounts). */
export type SeedChangeState = {
  v: 1;
  startedAt: number;
  updatedAt: number;
  seeded: boolean;
  done: boolean;
  /** Seed addresses whose history is still to be read. */
  addresses: string[];
  /** Transactions to examine, with their walk depth. */
  txs: [string, number][];
  /** Outpoints whose spender is still to be looked up, with their depth. */
  outpoints: [string, number][];
  examined: string[];
  /** Spender per outpoint looked up ('' = unspent). */
  spends: [string, string][];
  retry: Retry[];
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
   * Start points from storage. open: outputs whose spender storage doesn't know, or that it holds as unspent; they are
   * looked up. settled: outputs storage holds as spent by a settled transaction of its own (not looked up again).
   */
  storageOutpoints: () => Promise<{ open: string[]; settled: string[] }>;
  /** Addresses the seed derives. */
  seedAddresses: () => Promise<string[]>;
  /** Txids in an address's history (funding and spending); undefined when it couldn't be read. */
  addressHistory: (address: string) => Promise<string[] | undefined>;
  spentBy: (outpoint: string) => Promise<SpendState>;
  getRawTx: (txid: string) => Promise<number[] | undefined>;
  /** Add unspent change of one mined transaction to storage (never broadcasts). */
  claim: (txid: string, change: FoundChange[]) => Promise<ClaimResult>;
  /** Push to backups once at the end when something was added. */
  pushBackups?: () => Promise<unknown>;
  kv: SeedChangeKV;
  progress?: (step: string) => void;
  log?: (msg: string) => void;
  now?: () => number;
  /** Per-run time budget (default 4 min), walk depth limit (default 10 000 hops), transactions per scan (20 000). */
  runMs?: number;
  maxDepth?: number;
  maxTxs?: number;
};

export type SeedChangeReport = {
  /** The whole walk finished (nothing queued, nothing to retry). The next run starts a fresh scan. */
  done: boolean;
  /** This run stopped at its time budget; the next run carries on from the saved state. */
  paused: boolean;
  restoredSats: number;
  restored: number;
  alreadySats: number;
  pendingSats: number;
  heldSats: number;
  failed: number;
  retry: number;
  tooDeep: number;
  examined: number;
  lookups: number;
  error?: string;
};

const fresh = (now: number): SeedChangeState => ({
  v: 1,
  startedAt: now,
  updatedAt: now,
  seeded: false,
  done: false,
  addresses: [],
  txs: [],
  outpoints: [],
  examined: [],
  spends: [],
  retry: [],
  found: [],
  tooDeep: 0,
  stats: { lookups: 0, txs: 0, addresses: 0 },
});

const bsv = (sats: number) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');

let running: Promise<SeedChangeReport> | null = null;

/** One run at a time per worker; a second tap joins the run in flight. */
export function recoverSeedChange(deps: SeedChangeDeps): Promise<SeedChangeReport> {
  if (running) return running;
  running = runOnce(deps).finally(() => {
    running = null;
  });
  return running;
}

async function runOnce(deps: SeedChangeDeps): Promise<SeedChangeReport> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const progress = deps.progress ?? (() => undefined);
  const t0 = now();
  const runMs = deps.runMs ?? 240_000;
  const maxDepth = deps.maxDepth ?? 10_000;
  const maxTxs = deps.maxTxs ?? 20_000;

  const loaded = await deps.kv.load().catch(() => null);
  const s = loaded && loaded.v === 1 && !loaded.done ? loaded : fresh(t0);
  const examined = new Set(s.examined);
  const spends = new Map(s.spends);
  const key = (txid: string, vout: number) => `${txid}.${vout}`;
  const found = new Map(s.found.map((f) => [key(f.txid, f.vout), f]));
  const settled = new Set<string>();

  const save = async () => {
    s.examined = [...examined];
    s.spends = [...spends];
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
      tooDeep: s.tooDeep,
      examined: s.stats.txs,
      lookups: s.stats.lookups,
    };
  };

  try {
    // 1. Start points (once per scan). Storage's settled outputs are read every run: they prune the walk.
    progress('Reading this wallet’s records…');
    const fromStorage = await deps.storageOutpoints();
    for (const o of fromStorage.settled) settled.add(o);
    if (!s.seeded) {
      for (const o of new Set(fromStorage.open)) if (OUTPOINT.test(o) && !settled.has(o)) s.outpoints.push([o, 0]);
      progress('Listing the addresses your 12 words make…');
      s.addresses = [...new Set(await deps.seedAddresses())];
      s.seeded = true;
      await save();
    }
    // Work left unfinished last run goes back in its queue.
    for (const r of s.retry.splice(0)) {
      if (r.kind === 'tx') s.txs.push([r.id, r.depth]);
      else if (r.kind === 'outpoint') s.outpoints.push([r.id, r.depth]);
      else s.addresses.push(r.id);
    }

    let steps = 0;
    while (now() - t0 < runMs) {
      if (++steps % 20 === 0) {
        await save();
        say();
      }
      // a. Examine a transaction: does it carry this wallet's change?
      const t = s.txs.pop();
      if (t) {
        const [txid, depth] = t;
        if (examined.has(txid)) continue;
        if (examined.size >= maxTxs) {
          s.tooDeep++;
          continue;
        }
        const raw = await deps.getRawTx(txid).catch(() => undefined);
        if (!raw?.length) {
          s.retry.push({ kind: 'tx', id: txid, depth }); // not served yet, or the network is busy
          continue;
        }
        examined.add(txid);
        let tx: Transaction;
        try {
          tx = Transaction.fromBinary(raw);
        } catch {
          continue;
        }
        if (tx.id('hex') !== txid) continue;
        s.stats.txs++;
        for (const c of deterministicChangeOf(deps.keyDeriver, tx)) {
          const k = key(txid, c.vout);
          const f = found.get(k) ?? { txid, vout: c.vout, satoshis: c.satoshis, state: 'unspent' };
          found.set(k, f);
          if (settled.has(k)) {
            // Storage holds it as spent by a payment it knows: nothing to add, and that payment's change is held too.
            if (f.state === 'unspent') f.state = 'spent';
            continue;
          }
          const by = spends.get(k);
          if (by !== undefined) {
            // Already looked up (it was a start point): carry its answer over.
            if (by && f.state === 'unspent') f.state = 'spent';
            continue;
          }
          if (depth + 1 > maxDepth) {
            s.tooDeep++;
            continue;
          }
          s.outpoints.push([k, depth + 1]); // depth first: the walk reaches the unspent tail sooner
        }
        continue;
      }
      // b. Look up who spent a coin.
      const o = s.outpoints.pop();
      if (o) {
        const [outpoint, depth] = o;
        if (spends.has(outpoint) || settled.has(outpoint)) continue;
        const r = await deps.spentBy(outpoint).catch((): SpendState => ({ state: 'unclear' }));
        s.stats.lookups++;
        if (r.state === 'unclear') {
          s.retry.push({ kind: 'outpoint', id: outpoint, depth });
          continue;
        }
        spends.set(outpoint, r.state === 'spent' ? r.by : '');
        const f = found.get(outpoint);
        if (r.state === 'unspent') continue;
        if (f?.state === 'unspent') f.state = 'spent';
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
          s.retry.push({ kind: 'address', id: a, depth: 0 });
          continue;
        }
        for (const txid of new Set(h)) if (TXID.test(txid) && !examined.has(txid)) s.txs.push([txid, 0]);
        continue;
      }
      break;
    }
    const walkDone = !s.txs.length && !s.outpoints.length && !s.addresses.length && !s.retry.length;

    // 2. Claim every unspent change output found whose spend was checked (and any an earlier run couldn't add).
    const byTx = new Map<string, FoundEntry[]>();
    for (const f of found.values()) {
      const k = key(f.txid, f.vout);
      const retryable = f.state === 'pending' || f.state === 'failed';
      if (!(retryable || (f.state === 'unspent' && spends.get(k) === ''))) continue;
      byTx.set(f.txid, [...(byTx.get(f.txid) ?? []), f]);
    }
    let restoredNow = 0;
    let n = 0;
    for (const [txid, entries] of byTx) {
      progress(`Adding change ${++n} of ${byTx.size}…`);
      try {
        const raw = await deps.getRawTx(txid);
        const tx = raw?.length ? Transaction.fromBinary(raw) : undefined;
        const change = tx
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
            s.retry.push({ kind: 'outpoint', id: k, depth: 0 });
          }
        }
      } catch (err) {
        for (const e of entries) {
          e.state = 'failed';
          e.detail = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (restoredNow > 0 && deps.pushBackups) {
      progress('Saving to your backup…');
      await deps.pushBackups().catch((e) => log(`[seedChange] backup push failed: ${String(e)}`));
    }

    s.done = walkDone && !s.retry.length;
    await save();
    const report = { ...tally(), paused: !walkDone && now() - t0 >= runMs };
    log(
      `[seedChange] run ${now() - t0} ms: ${report.examined} txs, ${report.lookups} lookups, restored ${report.restoredSats} sats${report.paused ? ' (paused)' : ''}`,
    );
    return report;
  } catch (e) {
    await save();
    return { ...tally(), done: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  if (r.error) return `Couldn’t finish: ${r.error}. Nothing was broadcast; tap again to carry on.`;
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
  if (!parts.length)
    parts.push(
      r.alreadySats > 0
        ? `Checked ${r.examined} payments: all the change your 12 words can find is already in your wallet.`
        : `Checked ${r.examined} payments: no missing change found.`,
    );
  parts.push('Change from payments made before this update can’t be found this way.');
  return parts.join(' ');
}
