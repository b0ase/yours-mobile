/**
 * "Find my locks": BSV time-locks found from the 12 words alone.
 *
 * Every BSV lock this wallet makes (Lock BSV, pots, feed locks, @1sat/actions lockBsv) pays to one address: the
 * seed-derived key P1SAT_PROTOCOL / keyID 'lock' / self (lockApi.lockAddress). The Wallet's Locks row, auto-claim and
 * unlockBsv only read the `lock` basket in storage, so a wallet restored from the seed, or a new device, could not see
 * its locks. This finds them on chain and files each one into the `lock` basket with the tags and custom instructions
 * the normal lock flow writes (`until:<height>`, an `id:` tracking tag, {protocolID, keyID: 'lock'}), so listLocks and
 * unlockBsv work on it unchanged.
 *
 * Only 1Sat's indexer (api.1sat.app, through ctx.services) is asked, and only where to look: every lock is read from
 * its own transaction and kept only when its script is exactly Lock.lock(<this wallet's lock address>, until).
 *
 * Safe to run any number of times:
 * - a lock already in the lock basket is never internalized again (and the toolbox merges, never duplicates, a row);
 * - a lock the chain shows spent is left out (spends are checked right before filing; unknown = not filed);
 * - nothing is broadcast for a mined lock (its BEEF carries the proof), and no coin of the wallet is spent.
 *
 * Not findable this way: the optional lock receipt inscription (random keyID `inscribe-…`) and token escrows (keyID
 * from the bit-sign server). Token locks have their own finder (tokenLockApi.findTokenLocks).
 */
import { listLocks, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { Lock } from '@1sat/templates';
import { Hash, Utils, type Beef, type Transaction, type WalletInterface } from '@bsv/sdk';
import { lockAddress } from './lockApi';
import { splitOutpoint } from './tokenLocks';

export const LOCK_BASKET_NAME = 'lock';
/** Exactly what lockApi.lockTx, lockToPost and @1sat/actions lockBsv write. */
export const LOCK_CUSTOM_INSTRUCTIONS = JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: 'lock' });

/**
 * The `id:` tracking tag for a found lock: `id:<16 hex>_<vout>`, the shape @1sat/actions stamps (`<actionId>_<index>`).
 * The action id is derived from the txid, so every device that finds the same lock gives it the same id.
 */
export const foundLockIdTag = (txid: string, vout: number): string =>
  `id:${Utils.toHex(Hash.sha256(Utils.toArray(`bwx found lock\n${txid.toLowerCase()}`, 'utf8')).slice(0, 8))}_${vout}`;

/** The tags a lock created by this wallet carries (the id: differs only in its random action id). */
export const foundLockTags = (txid: string, vout: number, until: number): string[] => [
  `until:${until}`,
  foundLockIdTag(txid, vout),
];

export type BsvLockScan = {
  /** Unspent BSV locks of this wallet on chain. */
  found: number;
  /** Filed into the lock basket by this run. */
  added: number;
  addedSats: number;
  /** Already in the lock basket (left as they were). */
  already: number;
  /** Listed by the indexer but spent on chain: left out. */
  spent: number;
  /** Locks that could not be filed, with the reason (the next scan tries again). */
  failed: string[];
};

type LockOut = { txid: string; vout: number; until: number; satoshis: number };

const norm = (o: string) => {
  const p = splitOutpoint(o);
  return p ? `${p.txid}.${p.vout}` : o;
};

/** The wallet's lock basket rows, by outpoint "txid.vout". */
async function lockRows(ctx: OneSatContext) {
  const res = await listLocks.execute(ctx, { limit: 10000 });
  const rows = 'outputs' in res && res.outputs ? res.outputs : [];
  return new Map(rows.map((o) => [norm(o.outpoint), o]));
}

/** A lock of this wallet, exactly as the lock flow builds it, or null. */
export function lockAt(tx: Transaction, vout: number, address: string): { until: number; satoshis: number } | null {
  const out = tx.outputs[vout];
  if (!out?.satoshis || out.satoshis < 1) return null;
  const d = Lock.decode(out.lockingScript);
  if (!d || d.address !== address || !(d.until > 0)) return null;
  // Exactly the lock script, nothing around it (no inscription, no token envelope, no other owner).
  if (Lock.lock(address, d.until).toHex() !== out.lockingScript.toHex()) return null;
  return { until: d.until, satoshis: out.satoshis };
}

/**
 * Find this wallet's BSV locks on chain and file the missing ones into the lock basket. Throws when the indexer
 * cannot be reached or spends cannot be checked; storage is untouched then.
 */
export async function findBsvLocks(
  ctx: OneSatContext,
  account: string,
  onProgress?: (detail: string) => void,
): Promise<BsvLockScan> {
  const services = ctx.services;
  if (!services) throw new Error('The wallet services are not ready.');
  const address = await lockAddress(ctx);

  onProgress?.('Syncing your lock address…');
  let synced = false;
  for await (const ev of services.owner.getTxos(address, { refresh: true, limit: 1 })) {
    if (ev.type === 'error') throw ev.error;
    if (ev.type === 'done') {
      synced = true;
      break;
    }
  }
  if (!synced) throw new Error('The lock indexer stopped before it finished. Try again.');

  onProgress?.('Looking for locks…');
  const outs = (await services.txo.search(`own:${address}`, { unspent: true, limit: 0 })) ?? [];
  const byTx = new Map<string, Set<number>>();
  for (const o of outs) {
    const p = splitOutpoint(o.outpoint);
    if (p) byTx.set(p.txid, (byTx.get(p.txid) ?? new Set()).add(p.vout));
  }

  onProgress?.(byTx.size ? `Reading ${byTx.size} transaction${byTx.size === 1 ? '' : 's'}…` : 'Checking your wallet…');
  const locks: LockOut[] = [];
  const beefs = new Map<string, Beef>();
  let unreadable = 0;
  for (const [txid, vouts] of byTx) {
    try {
      const beef = await services.getBeefForTxid(txid);
      const tx = beef.findTxid(txid)?.tx;
      if (!tx || tx.id('hex') !== txid) throw new Error('missing');
      beefs.set(txid, beef);
      for (const vout of vouts) {
        const l = lockAt(tx, vout, address);
        if (l) locks.push({ txid, vout, ...l });
      }
    } catch {
      unreadable++;
    }
  }
  if (unreadable && unreadable === byTx.size) throw new Error('Could not load the lock transactions. Try again.');

  const before = await lockRows(ctx);
  const result: BsvLockScan = { found: locks.length, added: 0, addedSats: 0, already: 0, spent: 0, failed: [] };
  const fresh = locks.filter((l) => {
    if (!before.has(`${l.txid}.${l.vout}`)) return true;
    result.already++;
    return false;
  });

  // The chain, right before filing: a lock spent since the indexer listed it is never filed as spendable.
  let todo: LockOut[] = [];
  if (fresh.length) {
    onProgress?.('Checking they are still locked…');
    const spends = await services.txo.getSpends(fresh.map((l) => `${l.txid}.${l.vout}`));
    if (!Array.isArray(spends) || spends.length !== fresh.length)
      throw new Error('Could not check the locks. Try again.');
    todo = fresh.filter((l, i) => {
      if (spends[i] == null) return true;
      result.spent++;
      return false;
    });
  }

  const wallet = ctx.wallet as WalletInterface;
  const groups = new Map<string, LockOut[]>();
  for (const l of todo) groups.set(l.txid, [...(groups.get(l.txid) ?? []), l]);
  if (groups.size) onProgress?.(`Adding ${todo.length} lock${todo.length === 1 ? '' : 's'} to your wallet…`);
  for (const [txid, ls] of groups) {
    try {
      await wallet.internalizeAction({
        tx: beefs.get(txid)!.toBinaryAtomic(txid),
        outputs: ls.map((l) => ({
          outputIndex: l.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: LOCK_BASKET_NAME,
            customInstructions: LOCK_CUSTOM_INSTRUCTIONS,
            tags: foundLockTags(txid, l.vout, l.until),
          },
        })),
        description: `Found ${ls.length} lock${ls.length === 1 ? '' : 's'} from my seed`,
      });
    } catch (e) {
      for (const l of ls) result.failed.push(`${l.txid}.${l.vout}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Count what the wallet now lists, with the details unlockBsv needs; anything else is reported, not claimed.
  if (todo.length) {
    const after = await lockRows(ctx);
    for (const l of todo) {
      const op = `${l.txid}.${l.vout}`;
      if (result.failed.some((f) => f.startsWith(`${op}:`))) continue;
      const row = after.get(op);
      const ok =
        !!row &&
        !!row.tags?.includes(`until:${l.until}`) &&
        !!row.tags?.some((t) => t.startsWith('id:')) &&
        row.satoshis === l.satoshis;
      if (ok) {
        result.added++;
        result.addedSats += l.satoshis;
      } else
        result.failed.push(
          `${op}: ${row ? 'listed without its lock details' : 'not listed by the wallet (it may be spent by an unlock still in flight)'}`,
        );
    }
  }

  if (!result.failed.length) markBsvLocksScanned(account);
  return result;
}

const inflight = new Map<string, Promise<BsvLockScan>>();

/** findBsvLocks, one scan per account at a time (the Wallet's auto-scan and the Locks tab share it). */
export function scanBsvLocks(
  ctx: OneSatContext,
  account: string,
  onProgress?: (detail: string) => void,
): Promise<BsvLockScan> {
  const running = inflight.get(account);
  if (running) return running;
  const p = findBsvLocks(ctx, account, onProgress).finally(() => inflight.delete(account));
  inflight.set(account, p);
  return p;
}

// ── Recovery scan: once per account per device (like token locks), so a restored wallet finds its locks by itself. ──
const scanKey = (account: string) => `bwx.bsvLocks.scanned.${account}`;

export function bsvLocksScanned(account: string): boolean {
  try {
    return !!localStorage.getItem(scanKey(account));
  } catch {
    return false;
  }
}

export function markBsvLocksScanned(account: string) {
  try {
    localStorage.setItem(scanKey(account), new Date().toISOString());
  } catch {
    // storage blocked: the next open scans again, which is harmless
  }
}

export const bsvScanLine = (
  s:
    | { kind: 'idle' }
    | { kind: 'scanning'; detail: string }
    | { kind: 'error'; message: string }
    | { kind: 'done'; scan: BsvLockScan },
): string | null => {
  if (s.kind === 'idle') return null;
  if (s.kind === 'scanning') return s.detail;
  if (s.kind === 'error') return s.message;
  const r = s.scan;
  const parts: string[] = [];
  if (r.found === 0) parts.push('No BSV locks found on chain for this wallet.');
  else if (r.added > 0)
    parts.push(`Found ${r.found} lock${r.found === 1 ? '' : 's'} on chain (${r.added} added to your wallet).`);
  else if (r.already === r.found)
    parts.push(`Found ${r.found} lock${r.found === 1 ? '' : 's'} on chain, all already in your wallet.`);
  else parts.push(`Found ${r.found} lock${r.found === 1 ? '' : 's'} on chain.`);
  if (r.spent) parts.push(`${r.spent} already unlocked.`);
  if (r.failed.length) parts.push(`${r.failed.length} couldn't be added yet; try again later.`);
  return parts.join(' ');
};
