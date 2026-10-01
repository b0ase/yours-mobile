import type { OneSatContext } from '@1sat/actions';
import { Transaction } from '@bsv/sdk';
import type { Fetch } from './names';
import { EXPECTED_HASHES } from './opnsPow';
import {
  fetchMineNode,
  isTaken,
  loadNode,
  mintStep,
  OPNS_CHARSET,
  randomPrefix,
  type MintStepResult,
} from './opnsMint';

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
};

const isDoubleSpend = (e: unknown) =>
  /double|spent|conflict|missing.?inputs|DOUBLE_SPEND|SEEN_IN_ORPHAN/i.test(String(e));

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

  if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
  const first = await fetchMineNode(deps.fetch, name);
  if (!first) throw new Error(`No mine-tree node found for "${name}"`);

  const totalChars = name.length - first.domain.length;
  const steps: MintStepResult[] = [];
  let outpoint = first.outpoint;
  let beefHint: number[] | undefined;
  let fromIndexer = true; // the node came from the overlay (vs our own fresh child)
  let retries = 0;

  while (true) {
    if (signal.aborted) throw new MiningCancelled();
    const node = await load(deps.ctx, outpoint, beefHint);
    const domain = node.state.domain;
    if (!name.startsWith(domain)) throw new Error(`Tree node "${domain}" isn't a prefix of "${name}"`);
    if (domain === name) break;
    const char = name.charCodeAt(domain.length);
    const charIndex = domain.length - first.domain.length;
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
      const live = await fetchMineNode(deps.fetch, name);
      if (live && live.domain === domain && live.outpoint !== node.outpoint) {
        // Someone spent our node (mined another char from it). Seed changed: re-mine from the new node.
        outpoint = live.outpoint;
        beefHint = undefined;
        continue;
      }
      if (live && live.domain.length > domain.length) {
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
      if (isDoubleSpend(e) && retries++ < 5) {
        if (await isTaken(deps.fetch, name)) throw new NameTakenError(name);
        const live = await fetchMineNode(deps.fetch, name);
        if (!live) throw e;
        outpoint = live.outpoint;
        beefHint = undefined;
        fromIndexer = true;
        continue;
      }
      throw e;
    }
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
