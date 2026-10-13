import type { Fetch } from './names';
import { estimateMintFee, fetchMineNode, isTaken, NamesServerError, OPNS_CHARSET } from './opnsMint';
import { EXPECTED_HASHES } from './opnsPow';
import { MiningCancelled, NameTakenError, TreeHoldError } from './opnsRegister';
import type { OpnsTree } from './opnsTree';
import { releasedNote, type SweepResult } from './opnsTxStatus';

/**
 * "Mint a list" (owner, 13 Oct 2026): mine several OpNS names in one go from the user's own wallet.
 *
 *  parse → pre-flight (live lookups, shared-prefix plan, fee + time) → ONE approval → run the queue
 *  one name at a time through the normal mint path (mineName), re-checking each name right before it
 *  is mined. The queue is saved after every change so a closed window can resume where it stopped.
 * Funds only pay network fees; every name is locked to the wallet's own ordinal key, as for one name.
 */

export type ParsedList = { names: string[]; invalid: string[] };

/**
 * One name per line or comma/space separated (typed, ?mint= or an uploaded .txt). Blank lines and `#` comments
 * are ignored; names are lower-cased, a leading @ / $ dropped, duplicates removed; bad ones are returned in `invalid`.
 */
export const parseNameList = (text: string): ParsedList => {
  const names: string[] = [];
  const invalid: string[] = [];
  const tokens = text.split(/\r?\n/).flatMap((line) => line.replace(/#.*$/, '').split(/[\s,;]+/));
  for (const raw of tokens) {
    const n = raw
      .trim()
      .toLowerCase()
      .replace(/^[@$]+/, '');
    if (!n) continue;
    if (!OPNS_CHARSET.test(n)) {
      if (!invalid.includes(n)) invalid.push(n);
    } else if (!names.includes(n)) names.push(n);
  }
  return { names, invalid };
};

/** Why a name from the list can't be minted, in plain words (shown on its red chip). */
export const invalidReason = (name: string): string => {
  if (/[A-Z]/.test(name)) return 'lower-case only';
  if (/\s/.test(name)) return 'no spaces';
  if (/\./.test(name)) return 'no dots';
  if (/_/.test(name)) return 'no underscores; use -';
  return 'letters, numbers and - only';
};

/**
 * Mint order: alphabetical, which puts every prefix before the names that extend it
 * (b0as < b0ase < b0asex) and keeps names sharing a prefix together, so later names reuse it.
 */
export const orderForMinting = (names: string[]): string[] => [...names].sort();

export type NameCheck =
  | { name: string; state: 'free'; domain: string | null }
  | { name: string; state: 'taken'; listing?: TakenListing }
  | { name: string; state: 'mine' };

/** A taken name that its owner has listed for sale (OrdLock outpoint + price). */
export type TakenListing = { outpoint: string; priceSats: number };

export type PlannedName = NameCheck & {
  /** Characters this name still needs once the names before it in the list are mined. */
  chars: number;
  /** The prefix it is mined from: the tree's nearest node or an earlier name in the list. */
  from: string | null;
};

/**
 * Characters to mine per name, counting the prefixes earlier list names already mine. Minting `name` from
 * `domain` creates every prefix between them (opns.md mine tree), so a later name starts from the longest
 * of those that it continues.
 */
export const planBatch = (checks: NameCheck[]): PlannedName[] => {
  const covered = new Set<string>();
  return checks.map((c) => {
    if (c.state !== 'free' || c.domain === null) return { ...c, chars: 0, from: null };
    let from = c.domain;
    for (let n = c.name.length - 1; n > from.length; n--) {
      if (covered.has(c.name.slice(0, n))) {
        from = c.name.slice(0, n);
        break;
      }
    }
    for (let n = from.length + 1; n <= c.name.length; n++) covered.add(c.name.slice(0, n));
    return { ...c, chars: c.name.length - from.length, from };
  });
};

/**
 * Live check: taken / already mine / free (with the nearest mined prefix). `tree` (our local mine-tree cache)
 * makes names we just minted count as ours even before the indexer sees them, and lets a free name plan
 * from our own deeper unconfirmed node (b0asex from b0ase, not from the indexer's confirmed "b0").
 */
export const checkNames = async (
  f: Fetch,
  names: string[],
  isMine: (name: string) => boolean,
  tree?: OpnsTree,
  opts: {
    concurrency?: number;
    onResult?: (c: NameCheck) => void;
    signal?: AbortSignal;
    /** Taken names: is it listed for sale? (Optional; the search shows "Buy for $X" then.) */
    listingOf?: (name: string) => Promise<TakenListing | null>;
  } = {},
): Promise<NameCheck[]> => {
  const out: NameCheck[] = new Array(names.length);
  const one = async (name: string): Promise<NameCheck> => {
    if (isMine(name) || tree?.isOurs(name)) return { name, state: 'mine' };
    const lookup = await cachedLookup(f, name);
    if (lookup.taken) {
      const listing = opts.listingOf ? await opts.listingOf(name).catch(() => null) : null;
      return listing ? { name, state: 'taken', listing } : { name, state: 'taken' };
    }
    const indexed = lookup.node;
    const idxDomain = indexed && !tree?.isSpent(indexed.outpoint) ? indexed.domain : null;
    const local = tree?.best(name)?.domain ?? null;
    const domain = local !== null && (idxDomain === null || local.length >= idxDomain.length) ? local : idxDomain;
    return { name, state: 'free', domain: domain ?? indexed?.domain ?? null };
  };
  let next = 0;
  const worker = async () => {
    while (next < names.length && !opts.signal?.aborted) {
      const i = next++;
      out[i] = await one(names[i]);
      opts.onResult?.(out[i]);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? CHECK_CONCURRENCY, names.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out.filter(Boolean);
};

/** Parallel lookups for "Check": 8 at a time (was one name, two requests, at a time: ~1,000 names took minutes). */
export const CHECK_CONCURRENCY = 8;
/** A looked-up name is reused for this long, so editing a 1,000-name list doesn't look every name up again. */
const LOOKUP_TTL_MS = 5 * 60_000;
type Lookup = { taken: boolean; node: Awaited<ReturnType<typeof fetchMineNode>> };
// Keyed by the fetch function too, so callers (and tests) with different backends never share answers.
let lookupCaches = new WeakMap<Fetch, Map<string, { at: number; v: Promise<Lookup> }>>();
export const clearLookupCache = () => {
  lookupCaches = new WeakMap();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with backoff on 429 / 5xx / network errors (the indexer rate-limits bursts). */
export const withBackoff =
  (f: Fetch, tries = 4, baseMs = 300): Fetch =>
  async (url, init) => {
    for (let a = 0; ; a++) {
      try {
        const res = await f(url, init);
        if ((res.status === 429 || res.status >= 500) && a < tries - 1) {
          await sleep(baseMs * 2 ** a);
          continue;
        }
        return res;
      } catch (e) {
        if (a >= tries - 1) throw e;
        await sleep(baseMs * 2 ** a);
      }
    }
  };

const cachedLookup = (f: Fetch, name: string, now = Date.now()): Promise<Lookup> => {
  let lookupCache = lookupCaches.get(f);
  if (!lookupCache) lookupCaches.set(f, (lookupCache = new Map()));
  const hit = lookupCache.get(name);
  if (hit && now - hit.at < LOOKUP_TTL_MS) return hit.v;
  const bf = withBackoff(f);
  const v = (async () => {
    // Both lookups at once; the mine-node answer is only used when the name is free.
    const [taken, node] = await Promise.all([isTaken(bf, name), fetchMineNode(bf, name).catch(() => null)]);
    return { taken, node };
  })();
  lookupCache.set(name, { at: now, v });
  v.catch(() => lookupCache.delete(name));
  return v;
};

export type BatchSummary = { toMint: number; chars: number; feeSats: number; seconds: number };

export const summarise = (plan: PlannedName[], nodeScriptLen: number, hashRate: number): BatchSummary => {
  const chars = plan.reduce((s, p) => s + p.chars, 0);
  return {
    toMint: plan.filter((p) => p.chars > 0).length,
    chars,
    feeSats: chars * estimateMintFee(nodeScriptLen),
    seconds: (chars * EXPECTED_HASHES) / hashRate,
  };
};

// ---- the queue -----------------------------------------------------------------------------------------

export type ItemStatus = 'pending' | 'mining' | 'done' | 'skipped' | 'mine' | 'error';
export type BatchItem = {
  name: string;
  status: ItemStatus;
  txids: string[];
  note?: string;
  chars?: number;
  /** Auto-list: true once listed for sale after minting, false when that listing failed (retry offered). */
  listed?: boolean;
};
/**
 * `approvedSats` is the invoice total the one approval sheet showed. It is the batch's spending allowance:
 * the queue spends up to that +10% (ALLOWANCE_MARGIN) without asking again, then stops. `spentSats` is what
 * the mined characters cost so far (estimated per character). Pause stops spending; Clear revokes the allowance.
 */
export type BatchState = { v: 1; items: BatchItem[]; approvedSats: number; createdAt: number; spentSats?: number };
export const ALLOWANCE_MARGIN = 1.1;
export const allowanceCap = (s: BatchState) => Math.ceil(s.approvedSats * ALLOWANCE_MARGIN);
export const allowanceLeft = (s: BatchState) => Math.max(0, allowanceCap(s) - (s.spentSats ?? 0));

export const newBatch = (plan: PlannedName[], approvedSats: number, now = Date.now()): BatchState => ({
  v: 1,
  approvedSats,
  createdAt: now,
  items: plan
    .filter((p) => p.state === 'free' && p.chars > 0)
    .map((p) => ({ name: p.name, status: 'pending' as const, txids: [], chars: p.chars })),
});

export const remaining = (s: BatchState | null) =>
  s ? s.items.filter((i) => i.status === 'pending' || i.status === 'mining').length : 0;

export type KV = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};
const storageKey = (identityAddress: string) => `bwallet.opnsBatch.${identityAddress}`;
const ls = (): KV | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export const loadBatch = (identityAddress: string, kv: KV | null = ls()): BatchState | null => {
  try {
    const s = JSON.parse(kv?.getItem(storageKey(identityAddress)) ?? 'null') as BatchState | null;
    if (!s || s.v !== 1 || !Array.isArray(s.items)) return null;
    // A window closed mid-mine: that name starts again (characters already mined stay and are reused).
    return { ...s, items: s.items.map((i) => (i.status === 'mining' ? { ...i, status: 'pending' } : i)) };
  } catch {
    return null;
  }
};

export const saveBatch = (identityAddress: string, s: BatchState | null, kv: KV | null = ls()) => {
  try {
    if (s) kv?.setItem(storageKey(identityAddress), JSON.stringify(s));
    else kv?.removeItem(storageKey(identityAddress));
  } catch {
    /* storage unavailable */
  }
};

/**
 * Optional service fee for other users: $1 per name minted, paid to OPNS_FEE_ADDRESS (build-time
 * VITE_OPNS_FEE_ADDRESS). Empty by default, so there is no fee (owner, 13 Oct 2026: leave it unset for now).
 */
export const OPNS_FEE_ADDRESS: string = import.meta.env?.VITE_OPNS_FEE_ADDRESS ?? '';
export const OPNS_FEE_USD_PER_NAME = 1;
export const serviceFeeUsd = (namesToMint: number, address = OPNS_FEE_ADDRESS) =>
  address ? namesToMint * OPNS_FEE_USD_PER_NAME : 0;

export type MineOne = (name: string, signal: AbortSignal) => Promise<{ txid: string }[]>;

export type RunDeps = {
  fetch: Fetch;
  mine: MineOne;
  /** Pays the per-name service fee after a name is mined (only when OPNS_FEE_ADDRESS is set). */
  payFee?: (name: string) => Promise<string | undefined>;
  /**
   * Auto-list (owner, 13 Oct 2026): list the name for sale right after it is minted. Spends the new name output
   * from the wallet's own BEEF (no indexer wait). A failure here never stops the batch: the item is marked
   * "Minted · not listed" and the next name is mined.
   */
  afterMint?: (name: string) => Promise<string>;
  /** OpNS Vault (opnsVault.ts): asked at listing time; a kept / to-gift name is never auto-listed. */
  keep?: (name: string) => boolean;
  isMine: (name: string) => boolean;
  /** Our local mine-tree cache: names minted this session/recently count as ours while unconfirmed. */
  tree?: OpnsTree;
  /**
   * Evict mints the network never received (opnsTxStatus.ts sweepDeadMints). Run before every name, so a name whose
   * earlier mint died goes back to pending and is mined again in this run.
   */
  sweep?: () => Promise<SweepResult>;
  /**
   * Who has a taken name: one of this wallet's other accounts (the owner's CLI agent account mined the same list,
   * 13 Oct 2026) or someone else. Without it every taken name is "Taken by someone else".
   */
  takenBy?: (name: string) => Promise<'another-account' | 'other'>;
  save: (s: BatchState) => void;
  onUpdate: (s: BatchState) => void;
  /** Network fee per mined character (estimateMintFee); with it the run keeps to the approved allowance. */
  perCharSats?: number;
  /** Service fee per name in sats (counts against the allowance too). */
  perNameSats?: number;
};

export const ALLOWANCE_USED_UP = 'This batch has used its approved amount. Clear and approve the rest as a new batch';

export type RunResult = {
  stopped: 'finished' | 'cancelled' | 'error';
  error?: string;
  state: BatchState;
  /** Set when the run stopped because the names overlay (this host) isn't answering. */
  namesServer?: string;
};

export const TAKEN_OTHER = 'Taken by someone else';
export const YOURS_ELSEWHERE = 'Yours, in another account';
/** A name released twice in one run keeps failing to reach the network: stop retrying it until the next Resume. */
const MAX_REMINTS_PER_RUN = 2;

/**
 * Apply a dead-mint sweep to the queue: a name whose mint never reached the network is pending again, with its dead
 * txid dropped and its fee credited back to the allowance (nothing was spent). Names the sweep didn't touch keep
 * their state.
 */
export const applySweep = (state: BatchState, sweep: SweepResult, perCharSats = 0): BatchState => {
  if (!sweep.dead.length) return state;
  const deadTx = new Set(sweep.dead.map((d) => d.txid));
  const released = new Set(sweep.dead.flatMap((d) => d.names));
  let credit = 0;
  const items = state.items.map((it) => {
    if (!released.has(it.name) || it.status === 'skipped') return it;
    const txids = it.txids.filter((t) => !deadTx.has(t));
    credit += (it.txids.length - txids.length) * perCharSats;
    return { ...it, status: 'pending' as const, txids, note: releasedNote(it.name), listed: undefined };
  });
  return { ...state, items, spentSats: Math.max(0, (state.spentSats ?? 0) - credit) };
};

/**
 * Work through the pending items in order. Each name is re-checked right before mining: taken by someone
 * else → skipped; ours already → marked mine. A wallet error stops the run (the failed name stays pending
 * with the message, so Resume retries it); Cancel stops it with the current name still pending.
 */
export const runBatch = async (deps: RunDeps, start: BatchState, signal: AbortSignal): Promise<RunResult> => {
  // Resume: errors from the last run are stale (the fix may have shipped since); each name shows its own new result.
  let state: BatchState = {
    ...start,
    items: start.items.map((it) =>
      it.status === 'pending' || it.status === 'mining' || it.status === 'error'
        ? { ...it, status: 'pending' as const, note: undefined }
        : it,
    ),
  };
  const set = (i: number, patch: Partial<BatchItem>) => {
    state = { ...state, items: state.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) };
    deps.save(state);
    deps.onUpdate(state);
  };
  deps.onUpdate(state);
  // Names left pending with a hold note this run (tree not indexed yet): not tried again until the next Resume.
  const held = new Set<number>();
  const reminted = new Map<string, number>();
  const nextIndex = () => state.items.findIndex((it, j) => it.status === 'pending' && !held.has(j));
  const taken = async (i: number, name: string) => {
    const who = deps.takenBy ? await deps.takenBy(name).catch(() => 'other' as const) : 'other';
    if (who === 'another-account') set(i, { status: 'mine', note: YOURS_ELSEWHERE });
    else set(i, { status: 'skipped', note: TAKEN_OTHER });
  };
  for (let i = nextIndex(); i >= 0; i = nextIndex()) {
    if (signal.aborted) return { stopped: 'cancelled', state };
    if (deps.sweep) {
      const sw = await deps.sweep().catch(() => null);
      if (sw?.dead.length) {
        state = applySweep(state, sw, deps.perCharSats);
        for (const n of sw.dead.flatMap((d) => d.names)) {
          const k = state.items.findIndex((it) => it.name === n);
          if (k < 0) continue;
          held.delete(k);
          const times = (reminted.get(n) ?? 0) + 1;
          reminted.set(n, times);
          // A released name whose mint keeps dying is not re-mined for ever in one run.
          if (times > MAX_REMINTS_PER_RUN) {
            held.add(k);
            state = {
              ...state,
              items: state.items.map((it, j) =>
                j === k
                  ? { ...it, note: `${releasedNote(n)} Released ${times} times this run; Resume to try again.` }
                  : it,
              ),
            };
          }
        }
        deps.save(state);
        deps.onUpdate(state);
        i = nextIndex(); // a released name earlier in the list goes first
        if (i < 0) break;
      }
    }
    const it = state.items[i];
    try {
      if (deps.isMine(it.name) || deps.tree?.isOurs(it.name)) {
        set(i, { status: 'mine', note: deps.isMine(it.name) ? 'Already yours' : 'Yours, confirming' });
        continue;
      }
      if (await isTaken(deps.fetch, it.name)) {
        await taken(i, it.name);
        continue;
      }
      if (deps.perCharSats && it.chars !== undefined) {
        const need = it.chars * deps.perCharSats + (deps.perNameSats ?? 0);
        if (need > allowanceLeft(state)) {
          set(i, { status: 'pending', note: 'Over the approved amount' });
          return { stopped: 'error', error: ALLOWANCE_USED_UP, state };
        }
      }
      set(i, { status: 'mining', note: undefined });
      const steps = await deps.mine(it.name, signal);
      const txids = [...it.txids, ...steps.map((s) => s.txid)];
      state = {
        ...state,
        spentSats: (state.spentSats ?? 0) + steps.length * (deps.perCharSats ?? 0) + (deps.perNameSats ?? 0),
      };
      const feeTxid = deps.payFee ? await deps.payFee(it.name) : undefined;
      const minted = feeTxid ? [...txids, feeTxid] : txids;
      set(i, { status: 'done', txids: minted });
      if (deps.afterMint && steps.length && deps.keep?.(it.name)) {
        set(i, { note: 'In your Vault · not listed' });
      } else if (deps.afterMint && steps.length) {
        try {
          const listTxid = await deps.afterMint(it.name);
          set(i, { listed: true, note: undefined, txids: [...minted, listTxid] });
        } catch (e) {
          set(i, { listed: false, note: `Not listed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    } catch (e) {
      if (e instanceof MiningCancelled || signal.aborted) {
        set(i, { status: 'pending' });
        return { stopped: 'cancelled', state };
      }
      if (e instanceof NameTakenError) {
        await taken(i, it.name);
        continue;
      }
      if (e instanceof TreeHoldError) {
        // Our mint of it (or someone's extension of the tree) isn't indexed yet: leave it, mine the next name.
        set(i, { status: 'pending', note: e.message });
        held.add(i);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      set(i, { status: 'pending', note: msg });
      // The overlay is down: every name would fail the same way, so stop here (the page shows the server, not the tree).
      return { stopped: 'error', error: msg, state, ...(e instanceof NamesServerError && { namesServer: e.host }) };
    }
  }
  return { stopped: 'finished', state };
};

/** Router path of the page inside bMint (public URL /bmint/opns; old /opns-mint links redirect there). */
export const OPNS_MINT_ROUTE = '/m/bmint/opns';

/** ?mint=a,b,c on the names screen pre-fills the list (not a visible product button). */
export const mintParam = (search: string): string => {
  try {
    return (new URLSearchParams(search).get('mint') ?? '').split(',').join('\n');
  } catch {
    return '';
  }
};
