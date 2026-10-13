import { Transaction, Utils } from '@bsv/sdk';
import type { MintStepResult } from './opnsMint';

/**
 * Local mine-tree cache (bug 13 Oct 2026). The indexer (api.1sat.app opns/mine, opns/origin) only knows
 * CONFIRMED names, so after minting b0a → b0as → b0ase (all unconfirmed) a lookup for b0asex still
 * returned node "b0" — already spent by our own mempool tx — and the wallet refused the double-spend
 * (WERR_REVIEW_ACTIONS). Every successful mint step is recorded here: the child node (prefix + char,
 * output 1), the restated parent node (output 0), the BEEF with its unconfirmed ancestry, and the
 * outpoint it spent. Minting prefers the deepest unspent local node over the indexer's answer and never
 * reuses an outpoint we know is spent. Saved per identity, so a reload / Resume keeps it.
 */

export type CachedNode = { domain: string; outpoint: string; txid: string; beef?: string; at: number };
/**
 * One mint transaction we broadcast: the name it created, the node it spent and whether the network has since
 * been seen to hold it (`seen`). Needed to evict a mint the network never received (opnsTxStatus.ts).
 */
export type MintRecord = { name: string; parent: string; parentDomain: string; at: number; seen?: number };
export type TreeState = {
  v: 1;
  nodes: Record<string, CachedNode>;
  spent: Record<string, number>;
  names: Record<string, number>;
  /** Keyed by txid. Missing in caches written before 13 Oct 2026 (those mints can't be evicted, only aged out). */
  mints?: Record<string, MintRecord>;
};

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

const KEEP_MS = 14 * 24 * 3600 * 1000;
/** A spent mark only has to outlive the mempool: after confirmation the indexer has moved past it. */
const SPENT_MS = 2 * 24 * 3600 * 1000;
const norm = (op: string) => op.replace('_', '.');
const empty = (): TreeState => ({ v: 1, nodes: {}, spent: {}, names: {}, mints: {} });
export const shortTxid = (txid: string) => (txid.length > 12 ? `${txid.slice(0, 8)}…${txid.slice(-4)}` : txid);

export class OpnsTree {
  private s: TreeState;

  constructor(
    private kv: KV | null = null,
    private key = '',
    private now: () => number = Date.now,
  ) {
    this.s = this.load();
  }

  private load(): TreeState {
    try {
      const s = JSON.parse(this.kv?.getItem(this.key) ?? 'null') as TreeState | null;
      if (!s || s.v !== 1 || typeof s.nodes !== 'object') return empty();
      const cutoff = this.now() - KEEP_MS;
      const nodes = Object.fromEntries(Object.entries(s.nodes).filter(([, n]) => n.at >= cutoff));
      const names = Object.fromEntries(Object.entries(s.names ?? {}).filter(([, at]) => at >= cutoff));
      const spentCut = this.now() - SPENT_MS;
      const spent = Object.fromEntries(
        Object.entries(s.spent && !Array.isArray(s.spent) ? s.spent : {}).filter(([, at]) => at >= spentCut),
      );
      const mints = Object.fromEntries(
        Object.entries(s.mints && !Array.isArray(s.mints) ? s.mints : {}).filter(([, m]) => m.at >= cutoff),
      );
      return { v: 1, nodes, spent, names, mints };
    } catch {
      return empty();
    }
  }

  private save() {
    try {
      this.kv?.setItem(this.key, JSON.stringify(this.s));
    } catch {
      /* storage unavailable: the cache still works for this session */
    }
  }

  isSpent(outpoint: string) {
    return norm(outpoint) in this.s.spent;
  }

  markSpent(outpoint: string) {
    const op = norm(outpoint);
    if (this.isSpent(op)) return;
    this.s.spent[op] = this.now();
    for (const [d, n] of Object.entries(this.s.nodes)) if (n.outpoint === op) delete this.s.nodes[d];
    this.save();
  }

  /** A name we minted recently (maybe still unconfirmed): ours / in progress, never "free". */
  isOurs(name: string) {
    return name in this.s.names;
  }

  private get mints(): Record<string, MintRecord> {
    return (this.s.mints ??= {});
  }

  /** Our mint transaction that created `name`, if we still have it. */
  mintFor(name: string): (MintRecord & { txid: string }) | null {
    const e = Object.entries(this.mints).find(([, m]) => m.name === name);
    return e ? { txid: e[0], ...e[1] } : null;
  }

  /** Our mint transaction that spent `outpoint`, if any (a spent mark with no spender came from someone else). */
  spenderOf(outpoint: string): (MintRecord & { txid: string }) | null {
    const op = norm(outpoint);
    const e = Object.entries(this.mints).find(([, m]) => m.parent === op);
    return e ? { txid: e[0], ...e[1] } : null;
  }

  /** The network has this transaction (mempool or mined): never check it again, never evict it. */
  markSeen(txid: string) {
    const m = this.mints[txid];
    if (!m || m.seen) return;
    m.seen = this.now();
    this.save();
  }

  /** Mints the network has not been seen to hold, broadcast at least `graceMs` ago, oldest first. */
  unverified(graceMs: number): (MintRecord & { txid: string })[] {
    const cutoff = this.now() - graceMs;
    return Object.entries(this.mints)
      .filter(([, m]) => !m.seen && m.at <= cutoff)
      .sort(([, a], [, b]) => a.at - b.at)
      .map(([txid, m]) => ({ txid, ...m }));
  }

  /**
   * A mint the network never received (opnsTxStatus.ts): drop its nodes, forget its name as ours and make the node
   * it spent usable again, so the next mint starts from there. Every later mint chained from it is dead too and
   * goes the same way. Returns the names released, this one first.
   */
  forget(txid: string): string[] {
    const m = this.mints[txid];
    if (!m) return [];
    const released = [m.name];
    delete this.mints[txid];
    for (const [d, n] of Object.entries(this.s.nodes)) if (n.txid === txid) delete this.s.nodes[d];
    delete this.s.names[m.name];
    const stillSpentBy = Object.values(this.mints).some((o) => o.parent === m.parent);
    if (!stillSpentBy) delete this.s.spent[m.parent];
    // The parent node was overwritten by this tx's restated copy (record()): put the one it spent back.
    const parentTxid = m.parent.split('.')[0];
    const sibling = Object.values(this.s.nodes).find((n) => n.txid === parentTxid);
    if (!stillSpentBy && !this.s.nodes[m.parentDomain] && (sibling || parentTxid in this.mints)) {
      this.s.nodes[m.parentDomain] = {
        domain: m.parentDomain,
        outpoint: m.parent,
        txid: parentTxid,
        beef: sibling?.beef,
        at: sibling?.at ?? this.now(),
      };
    }
    for (const [child, c] of Object.entries(this.mints))
      if (c.parent.startsWith(`${txid}.`)) released.push(...this.forget(child));
    this.save();
    return released;
  }

  /** The deepest unspent node we created whose domain is a prefix of `name` (or `name` itself). */
  best(name: string): CachedNode | null {
    for (let n = name.length; n >= 1; n--) {
      const c = this.s.nodes[name.slice(0, n)];
      if (c && !this.isSpent(c.outpoint)) return c;
    }
    return null;
  }

  beefFor(c: CachedNode): number[] | undefined {
    return c.beef ? Utils.toArray(c.beef, 'hex') : undefined;
  }

  /** After a mint step broadcast: `spent` (the node it consumed) is gone, outputs 0 and 1 are live nodes. */
  record(spent: string, parentDomain: string, step: MintStepResult) {
    let beef: string | undefined;
    try {
      beef = step.tx ? Utils.toHex(Transaction.fromAtomicBEEF(step.tx).toBEEF()) : undefined;
    } catch {
      beef = undefined;
    }
    const at = this.now();
    const op = norm(spent);
    this.s.spent[op] = at;
    this.s.nodes[parentDomain] = { domain: parentDomain, outpoint: `${step.txid}.0`, txid: step.txid, beef, at };
    this.s.nodes[step.newDomain] = { domain: step.newDomain, outpoint: step.childOutpoint, txid: step.txid, beef, at };
    this.s.names[step.newDomain] = at;
    this.mints[step.txid] = { name: step.newDomain, parent: op, parentDomain, at };
    this.save();
  }
}

const memory = new Map<string, OpnsTree>();

/** The wallet's shared tree cache in localStorage (one per identity, same object across the app). */
export const opnsTreeFor = (identityAddress: string): OpnsTree => {
  const key = `bwallet.opnsTree.${identityAddress}`;
  let t = memory.get(key);
  if (!t) {
    let kv: KV | null = null;
    try {
      kv = localStorage;
    } catch {
      kv = null;
    }
    t = new OpnsTree(kv, key);
    memory.set(key, t);
  }
  return t;
};
