import type { Fetch } from './names';
import { estimateMintFee, fetchMineNode, isTaken, OPNS_CHARSET } from './opnsMint';
import { EXPECTED_HASHES } from './opnsPow';
import { MiningCancelled, NameTakenError } from './opnsRegister';

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

/**
 * Mint order: alphabetical, which puts every prefix before the names that extend it
 * (b0as < b0ase < b0asex) and keeps names sharing a prefix together, so later names reuse it.
 */
export const orderForMinting = (names: string[]): string[] => [...names].sort();

export type NameCheck =
  | { name: string; state: 'free'; domain: string | null }
  | { name: string; state: 'taken' }
  | { name: string; state: 'mine' };

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

/** Live check: taken / already mine / free (with the nearest mined prefix). */
export const checkNames = async (
  f: Fetch,
  names: string[],
  isMine: (name: string) => boolean,
): Promise<NameCheck[]> => {
  const out: NameCheck[] = [];
  for (const name of names) {
    if (isMine(name)) out.push({ name, state: 'mine' });
    else if (await isTaken(f, name)) out.push({ name, state: 'taken' });
    else out.push({ name, state: 'free', domain: (await fetchMineNode(f, name))?.domain ?? null });
  }
  return out;
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
export type BatchItem = { name: string; status: ItemStatus; txids: string[]; note?: string };
export type BatchState = { v: 1; items: BatchItem[]; approvedSats: number; createdAt: number };

export const newBatch = (plan: PlannedName[], approvedSats: number, now = Date.now()): BatchState => ({
  v: 1,
  approvedSats,
  createdAt: now,
  items: plan
    .filter((p) => p.state === 'free' && p.chars > 0)
    .map((p) => ({ name: p.name, status: 'pending' as const, txids: [] })),
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
  isMine: (name: string) => boolean;
  save: (s: BatchState) => void;
  onUpdate: (s: BatchState) => void;
};

export type RunResult = { stopped: 'finished' | 'cancelled' | 'error'; error?: string; state: BatchState };

/**
 * Work through the pending items in order. Each name is re-checked right before mining: taken by someone
 * else → skipped; ours already → marked mine. A wallet error stops the run (the failed name stays pending
 * with the message, so Resume retries it); Cancel stops it with the current name still pending.
 */
export const runBatch = async (deps: RunDeps, start: BatchState, signal: AbortSignal): Promise<RunResult> => {
  let state = start;
  const set = (i: number, patch: Partial<BatchItem>) => {
    state = { ...state, items: state.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) };
    deps.save(state);
    deps.onUpdate(state);
  };
  for (let i = 0; i < state.items.length; i++) {
    const it = state.items[i];
    if (it.status !== 'pending' && it.status !== 'mining') continue;
    if (signal.aborted) return { stopped: 'cancelled', state };
    try {
      if (deps.isMine(it.name)) {
        set(i, { status: 'mine', note: 'Already yours' });
        continue;
      }
      if (await isTaken(deps.fetch, it.name)) {
        set(i, { status: 'skipped', note: 'Taken by someone else' });
        continue;
      }
      set(i, { status: 'mining', note: undefined });
      const steps = await deps.mine(it.name, signal);
      const txids = [...it.txids, ...steps.map((s) => s.txid)];
      const feeTxid = deps.payFee ? await deps.payFee(it.name) : undefined;
      set(i, { status: 'done', txids: feeTxid ? [...txids, feeTxid] : txids });
    } catch (e) {
      if (e instanceof MiningCancelled || signal.aborted) {
        set(i, { status: 'pending' });
        return { stopped: 'cancelled', state };
      }
      if (e instanceof NameTakenError) {
        set(i, { status: 'skipped', note: 'Taken by someone else' });
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      set(i, { status: 'pending', note: msg });
      return { stopped: 'error', error: msg, state };
    }
  }
  return { stopped: 'finished', state };
};

/** ?mint=a,b,c on the names screen pre-fills the list (not a visible product button). */
export const mintParam = (search: string): string => {
  try {
    return (new URLSearchParams(search).get('mint') ?? '').split(',').join('\n');
  } catch {
    return '';
  }
};
