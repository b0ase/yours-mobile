import type { OneSatContext } from '@1sat/actions';
import { OpNS } from '@1sat/templates';
import { Transaction } from '@bsv/sdk';
import type { Fetch } from './names';
import { EXPECTED_HASHES } from './opnsPow';
import {
  fetchMineNode,
  isCharClaimed,
  isTaken,
  loadNode,
  mintStep,
  OPNS_CHARSET,
  randomPrefix,
  type LoadedNode,
  type MineNode,
  type MintStepResult,
} from './opnsMint';
import type { OpnsTree } from './opnsTree';
import { confirmingNote } from './opnsTxStatus';

/**
 * Register a brand-new OpNS name: mine it character by character on-device, one mint
 * transaction per missing character, chaining each step from the child node we just made.
 *
 * Races: anyone may spend the same tree node. Before every broadcast we re-read the
 * tree; if the name became taken we stop (NameTakenError); if our node was spent by
 * someone else we re-mine the character from the new node.
 */

export class NameTakenError extends Error {
  constructor(name: string) {
    super(`"${name}" was just taken by someone else`);
  }
}
export class MiningCancelled extends Error {
  constructor() {
    super('Mining cancelled');
  }
}
/**
 * The name can't be mined right now because the tree is ahead of the indexer: our own mint of it (txid, when we
 * know it) is on the network but not indexed yet, or someone else extended the node we needed. Not a wallet error:
 * the batch leaves the name pending and moves on (opnsBatch.ts). A mint the network never received is a different
 * state and is evicted before mining starts (opnsTxStatus.ts), so it never surfaces here.
 */
export class TreeHoldError extends Error {
  constructor(
    public readonly held: string,
    public readonly txid?: string,
  ) {
    super(confirmingNote(held, txid));
    this.name = 'TreeHoldError';
  }
}

export type Progress = {
  phase: 'mining' | 'broadcasting' | 'done';
  /** The prefix mined so far and the character being mined now. */
  domain: string;
  charIndex: number; // 0-based among the characters still to mine
  charsTotal: number;
  tried: number; // attempts on the current character
  rate: number; // hashes/s
  /** Expected seconds left (current char remainder + remaining chars). */
  etaSeconds: number;
};

export type MineChar = (
  pow: number[],
  char: number,
  signal: AbortSignal,
  onProgress: (tried: number, rate: number) => void,
) => Promise<{ nonce: number[]; hash: number[] }>;

/** Default miner: a Web Worker running opnsMiner.worker.ts. Cancel = terminate. */
export const workerMineChar: MineChar = (pow, char, signal, onProgress) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new MiningCancelled());
    const w = new Worker(new URL('./opnsMiner.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      w.terminate();
      reject(new MiningCancelled());
    };
    signal.addEventListener('abort', stop, { once: true });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.tried, m.rate);
      else if (m.type === 'found') {
        signal.removeEventListener('abort', stop);
        w.terminate();
        resolve({ nonce: m.nonce, hash: m.hash });
      } else if (m.type === 'exhausted') {
        signal.removeEventListener('abort', stop);
        w.terminate();
        reject(new Error('Nonce space exhausted; try again'));
      }
    };
    w.onerror = (e) => {
      signal.removeEventListener('abort', stop);
      w.terminate();
      reject(new Error(e.message || 'Miner crashed'));
    };
    w.postMessage({ pow, char, prefix: randomPrefix() });
  });

export type RegisterDeps = {
  ctx: OneSatContext;
  fetch: Fetch;
  mineChar?: MineChar;
  /** Injected for tests; defaults to the real mintStep. */
  mint?: typeof mintStep;
  load?: typeof loadNode;
  /** Local mine-tree cache: our own (maybe unconfirmed) nodes, preferred over the indexer. See opnsTree.ts. */
  tree?: OpnsTree;
};

const errText = (e: unknown) => {
  const o = (e ?? {}) as { name?: unknown; code?: unknown };
  return `${String(o.name ?? '')} ${String(o.code ?? '')} ${String(e)}`;
};
/** A rejected broadcast for a node that's already spent (incl. the wallet's WERR_REVIEW_ACTIONS on a double-spend). */
export const isDoubleSpend = (e: unknown) =>
  /double|spent|conflict|missing.?inputs|DOUBLE_SPEND|SEEN_IN_ORPHAN|REVIEW_ACTIONS|require review/i.test(errText(e));

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/**
 * The 1Sat overlay (opns/mine) can be days behind: the node it returns for a prefix may have been spent long
 * ago, so every mint from it double-spent and the page said "still catching up" (owner, 14 Oct 2026, "kooky" /
 * "danielwagner"). Walk the node's spends forward on WhatsOnChain to the live head. Every spend restates the
 * parent as output 0, so the domain never changes; 404 = unspent = the head. Same walk as bwalletx-cli.
 */
export const followForward = async (f: RegisterDeps['fetch'], outpoint: string, maxHops = 60): Promise<string> => {
  const sep = outpoint.includes('_') ? '_' : '.';
  const [first, v] = outpoint.split(/[._]/);
  let txid = first;
  let vout = Number(v);
  let waits = 0;
  for (let hop = 0; hop < maxHops; ) {
    const res = await f(`${WOC}/tx/${txid}/${vout}/spent`).catch(() => null);
    if (!res) break;
    if (res.status === 429 && waits++ < 5) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) break;
    const j = (await res.json().catch(() => null)) as { txid?: string } | null;
    if (!j?.txid) break;
    txid = j.txid;
    vout = 0;
    hop++;
  }
  return `${txid}${sep}${vout}`;
};

/** The overlay's nearest node for `name`, moved to its live head. */
const liveMineNode = async (f: RegisterDeps['fetch'], name: string): Promise<MineNode | null> => {
  const n = await fetchMineNode(f, name);
  return n ? { ...n, outpoint: await followForward(f, n.outpoint) } : n;
};

type Start = { outpoint: string; domain: string; beefHint?: number[]; fromIndexer: boolean };

/** Deepest unspent node for `name`: our own cached node when it is at least as deep as the indexer's. */
const pickNode = (tree: OpnsTree | undefined, name: string, indexed: MineNode | null): Start | null => {
  const local = tree?.best(name) ?? null;
  const idx = indexed && !tree?.isSpent(indexed.outpoint) ? indexed : null;
  if (local && (!idx || local.domain.length >= idx.domain.length))
    return { outpoint: local.outpoint, domain: local.domain, beefHint: tree?.beefFor(local), fromIndexer: false };
  if (idx) return { outpoint: idx.outpoint, domain: idx.domain, fromIndexer: true };
  return null;
};

/** The child node `domain` minted in the same tx as this restated parent (output 1), when that is what it is. */
const childOf = (node: LoadedNode, domain: string): string | null => {
  const out = node.tx.outputs[1];
  const st = node.vout === 0 && out ? OpNS.decode(out.lockingScript) : null;
  return st?.domain === domain ? `${node.tx.id('hex')}.1` : null;
};

/** The hold for `name` when the node we needed (`outpoint`) is spent: by our own mint (named) or by someone else. */
const hold = (tree: OpnsTree | undefined, name: string, outpoint?: string) =>
  new TreeHoldError(name, (outpoint && tree?.spenderOf(outpoint)?.txid) || tree?.mintFor(name)?.txid);

export const mineName = async (
  deps: RegisterDeps,
  rawName: string,
  signal: AbortSignal,
  onProgress: (p: Progress) => void,
): Promise<MintStepResult[]> => {
  const name = rawName.trim().toLowerCase();
  if (!OPNS_CHARSET.test(name)) throw new Error('Names use a-z, 0-9 and - only');
  const mineChar = deps.mineChar ?? workerMineChar;
  const mint = deps.mint ?? mintStep;
  const load = deps.load ?? loadNode;
  const tree = deps.tree;

  // Already minted by us (maybe unconfirmed, so the indexer doesn't know yet): nothing to do.
  if (tree?.isOurs(name)) return [];
  if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
  const indexed = await liveMineNode(deps.fetch, name);
  const first = pickNode(tree, name, indexed);
  if (!first) {
    if (!indexed) throw new Error(`No mine-tree node found for "${name}"`);
    throw hold(tree, name, indexed.outpoint);
  }

  const totalChars = name.length - first.domain.length;
  const steps: MintStepResult[] = [];
  let outpoint = first.outpoint;
  let beefHint = first.beefHint;
  let fromIndexer = first.fromIndexer; // the node came from the overlay (vs our own fresh/cached child)
  let retries = 0;

  while (true) {
    if (signal.aborted) throw new MiningCancelled();
    const node = await load(deps.ctx, outpoint, beefHint);
    const domain = node.state.domain;
    if (!name.startsWith(domain)) throw new Error(`Tree node "${domain}" isn't a prefix of "${name}"`);
    if (domain === name) break;
    const char = name.charCodeAt(domain.length);
    if (isCharClaimed(node.state.claimed, char)) {
      // This node already has our next char mined (e.g. it is the restated parent of our own unconfirmed mint
      // and the cache / indexer pointed back at it). Mining it again fails the covenant: go to the child.
      const child = childOf(node, domain + name[domain.length]);
      if (!child || tree?.isSpent(child) || retries++ >= 3) throw hold(tree, name, child ?? undefined);
      outpoint = child;
      beefHint = node.beef;
      fromIndexer = false;
      continue;
    }
    const charIndex = Math.max(0, domain.length - first.domain.length);
    const remainingAfter = name.length - domain.length - 1;

    const { nonce, hash } = await mineChar(node.state.pow, char, signal, (tried, rate) =>
      onProgress({
        phase: 'mining',
        domain,
        charIndex,
        charsTotal: totalChars,
        tried,
        rate,
        etaSeconds:
          rate > 0 ? Math.max(0, EXPECTED_HASHES - tried) / rate + (remainingAfter * EXPECTED_HASHES) / rate : Infinity,
      }),
    );
    if (signal.aborted) throw new MiningCancelled();

    // Re-check the tree right before broadcasting.
    if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
    if (fromIndexer) {
      const live = await liveMineNode(deps.fetch, name);
      const usable = live && !tree?.isSpent(live.outpoint);
      if (usable && live.domain === domain && live.outpoint !== node.outpoint) {
        // Someone spent our node (mined another char from it). Seed changed: re-mine from the new node.
        outpoint = live.outpoint;
        beefHint = undefined;
        continue;
      }
      if (usable && live.domain.length > domain.length) {
        // Someone extended the tree along our path; continue from their node.
        outpoint = live.outpoint;
        beefHint = undefined;
        continue;
      }
    }

    onProgress({ phase: 'broadcasting', domain, charIndex, charsTotal: totalChars, tried: 0, rate: 0, etaSeconds: 0 });
    let step: MintStepResult;
    try {
      step = await mint(deps.ctx, node, char, nonce, hash);
    } catch (e) {
      if (!isDoubleSpend(e)) throw e;
      // That node is gone (spent by someone, maybe our own unconfirmed mint): never try it again.
      tree?.markSpent(node.outpoint);
      if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
      const next = pickNode(tree, name, await liveMineNode(deps.fetch, name));
      if (retries++ >= 3 || !next || next.outpoint === node.outpoint) throw hold(tree, name, node.outpoint);
      outpoint = next.outpoint;
      beefHint = next.beefHint;
      fromIndexer = next.fromIndexer;
      continue;
    }
    tree?.record(node.outpoint, domain, step);
    steps.push(step);
    if (step.newDomain === name) break;
    outpoint = step.childOutpoint;
    beefHint = step.tx ? Transaction.fromAtomicBEEF(step.tx).toBEEF() : undefined;
    fromIndexer = !beefHint;
  }
  onProgress({
    phase: 'done',
    domain: name,
    charIndex: totalChars,
    charsTotal: totalChars,
    tried: 0,
    rate: 0,
    etaSeconds: 0,
  });
  return steps;
};

/** Poll the overlay until the name's origin is indexed (i.e. the mint was accepted). */
export const waitForOrigin = async (
  f: Fetch,
  name: string,
  signal: AbortSignal,
  timeoutMs = 180_000,
  everyMs = 5000,
) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (signal.aborted) return false;
    if (await isTaken(f, name).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
};

export const formatEta = (s: number) => {
  if (!Number.isFinite(s)) return 'estimating…';
  if (s < 60) return `~${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  return `~${(s / 3600).toFixed(1)} h`;
};
