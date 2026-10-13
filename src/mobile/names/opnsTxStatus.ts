import type { Fetch } from './names';
import { shortTxid, type OpnsTree } from './opnsTree';

/**
 * Mints the network never received (owner, 13 Oct 2026). The browser minter broadcast 14 transactions; WhatsOnChain
 * had never seen 9 of them (a competing miner took the same tree nodes first, so the mempool dropped ours), yet the
 * local mine-tree cache still treated their nodes and names as ours. Every name then ended in "still catching up"
 * for hours. Here each cached unconfirmed mint is checked against WhatsOnChain once it is older than DEAD_GRACE_MS:
 * seen (mempool or mined) → remembered, never checked again; 404 → dead: its nodes and names are dropped and the
 * node it spent is usable again (OpnsTree.forget); 429 / 5xx / network error → unknown, checked again next time.
 *
 * What this can't do: free the wallet's own record of the dead transaction. The wallet interface has no call for
 * that (abortAction refuses an action it believes it broadcast); the wallet's background review gives such
 * transactions up on its own schedule (services/stuckSends.ts). A dead mint the wallet already marked failed is
 * passed in as `offChain` and evicted at once, without waiting for the grace period.
 */

export type TxNetStatus = 'mined' | 'mempool' | 'missing' | 'unknown';

export const WOC_TX = 'https://api.whatsonchain.com/v1/bsv/main/tx/hash';
/** A broadcast transaction WhatsOnChain still hasn't seen after this long never reached the network. */
export const DEAD_GRACE_MS = 2 * 60_000;

/** WhatsOnChain's verdict on one txid. 429 (rate-limited) is "unknown", not "missing". */
export const txNetStatus = async (f: Fetch, txid: string): Promise<TxNetStatus> => {
  let res: Response;
  try {
    res = await f(`${WOC_TX}/${txid}`);
  } catch {
    return 'unknown';
  }
  if (res.status === 404) return 'missing';
  if (!res.ok) return 'unknown';
  const j = (await res.json().catch(() => null)) as { blockheight?: number; confirmations?: number } | null;
  if (!j) return 'unknown';
  return (j.blockheight ?? 0) > 0 || (j.confirmations ?? 0) > 0 ? 'mined' : 'mempool';
};

export type DeadMint = { txid: string; names: string[] };
export type SweepResult = {
  /** Mints evicted this sweep, with every name released (the dead mint's own name first, then mints chained from it). */
  dead: DeadMint[];
  /** Mints the network has (mempool or mined). */
  seen: { txid: string; name: string; status: 'mined' | 'mempool' }[];
  /** Mints whose status couldn't be read (rate-limited or offline): left as they are, checked again next time. */
  unknown: string[];
};

export type SweepOpts = {
  graceMs?: number;
  /** Txids the wallet itself knows never went out (status failed / nosend): dead at once. */
  offChain?: Set<string>;
  /** Parallel WhatsOnChain lookups (a dozen mints at 3 requests/s is fine; more would 429). */
  concurrency?: number;
};

/** Check the cache's unverified mints and evict the dead ones. Safe to run on page load, Resume and after a run. */
export const sweepDeadMints = async (tree: OpnsTree, f: Fetch, opts: SweepOpts = {}): Promise<SweepResult> => {
  const out: SweepResult = { dead: [], seen: [], unknown: [] };
  const offChain = opts.offChain ?? new Set<string>();
  const graceMs = opts.graceMs ?? DEAD_GRACE_MS;
  const evict = (txid: string) => {
    const names = tree.forget(txid);
    if (names.length) out.dead.push({ txid, names });
  };
  for (const m of tree.unverified(0)) if (offChain.has(m.txid)) evict(m.txid);
  const todo = tree.unverified(graceMs);
  const statuses = new Map<string, TxNetStatus>();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const m = todo[next++];
      statuses.set(m.txid, await txNetStatus(f, m.txid));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, todo.length)) }, worker));
  // Oldest first: a dead parent takes its children with it (forget cascades), so they are not looked at again.
  for (const m of todo) {
    if (!tree.mintFor(m.name)) continue; // already evicted with its parent
    const st = statuses.get(m.txid) ?? 'unknown';
    if (st === 'missing') evict(m.txid);
    else if (st === 'unknown') out.unknown.push(m.txid);
    else {
      tree.markSeen(m.txid);
      out.seen.push({ txid: m.txid, name: m.name, status: st });
    }
  }
  return out;
};

/** The one-line note for a name whose last mint never reached the network. */
export const releasedNote = (name: string) =>
  `Your last mint of ${name} never reached the network. It has been released; Resume mines it again.`;

/** The one-line note for a name whose mint is on the network but not indexed yet. */
export const confirmingNote = (name: string, txid?: string) =>
  txid
    ? `Your last mint of ${name} (${shortTxid(txid)}) is on the network but not indexed yet. Wait for it to confirm (about 10 minutes), then Resume.`
    : `The name tree for ${name} is still catching up with the network. Wait a few minutes, then Resume.`;
