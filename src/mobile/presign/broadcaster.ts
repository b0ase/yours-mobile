/**
 * Pre-signed payments — refund broadcaster (docs/PRESIGNED-PAYMENTS.md §2, §4.3).
 *
 * On any app open (or a background wake) the wallet refunds every open slot
 * whose deadline has passed. Rules:
 *  - never broadcast before the tip reaches T (open item 2: ARC may reject or hold);
 *  - the signed refund is stored BEFORE broadcasting, and retries resend the same tx;
 *  - "already known" means done; "missing inputs / double spend" means the slot
 *    was claimed first (first mined wins), so it is marked spent.
 */
import type { Transaction } from '@bsv/sdk';
import type { PresignStore, StoredSet, StoredSlot } from './store';
import { refundFinal } from './validate';

export interface BroadcastResult {
  ok: boolean;
  txid?: string;
  /** raw error text from the endpoint */
  message?: string;
}
export type BroadcastFn = (rawHex: string) => Promise<BroadcastResult>;
export type BuildRefundFn = (set: StoredSet, slot: StoredSlot) => Promise<Transaction>;

export type ErrorKind = 'known' | 'spent' | 'non-final' | 'retry';

export function classifyBroadcastError(message = ''): ErrorKind {
  const m = message.toLowerCase();
  if (/already (known|in the mempool|mined)|txn-already-known|seen_on_network/.test(m)) return 'known';
  if (/missing ?inputs|double.?spend|txn-mempool-conflict|inputs.*spent|bad-txns-inputs/.test(m)) return 'spent';
  if (/non-final|non_final|64: |locktime/.test(m)) return 'non-final';
  return 'retry';
}

export interface RunSummary {
  refunded: string[];
  spent: string[];
  waiting: string[];
  failed: { slot: string; error: string }[];
}

/** Earliest refund height among open slots, for scheduling the next wake. */
export async function nextRefundHeight(store: PresignStore): Promise<number | null> {
  let best: number | null = null;
  for (const { set } of await store.openSlots())
    if (set.autoReturn && (best === null || set.until < best)) best = set.until;
  return best;
}

export async function runDueRefunds(args: {
  store: PresignStore;
  tipHeight: number;
  buildRefund: BuildRefundFn;
  broadcast: BroadcastFn;
  /** include sets with auto-return off (the "Take back unclaimed" button) */
  manual?: boolean;
}): Promise<RunSummary> {
  const out: RunSummary = { refunded: [], spent: [], waiting: [], failed: [] };
  for (const { set, slot } of await args.store.openSlots()) {
    const tag = `${set.id}:${slot.index}`;
    if (!set.autoReturn && !args.manual) continue;
    if (!slot.outpoint) continue; // creation never broadcast: nothing locked
    if (!refundFinal(args.tipHeight, set.until)) {
      out.waiting.push(tag);
      continue;
    }
    try {
      let raw = slot.refundRawHex;
      let txid = slot.refundTxid;
      if (!raw) {
        const tx = await args.buildRefund(set, slot);
        raw = tx.toHex();
        txid = tx.id('hex');
        await args.store.update(set.id, slot.index, 'refunding', { refundRawHex: raw, refundTxid: txid });
      }
      const r = await args.broadcast(raw);
      const kind = r.ok ? 'known' : classifyBroadcastError(r.message);
      if (kind === 'known') {
        await args.store.update(set.id, slot.index, 'refunded', { refundTxid: r.txid ?? txid, lastError: undefined });
        out.refunded.push(tag);
      } else if (kind === 'spent') {
        await args.store.update(set.id, slot.index, 'spent', { lastError: r.message });
        out.spent.push(tag);
      } else {
        await args.store.update(set.id, slot.index, 'refunding', { lastError: r.message });
        out.failed.push({ slot: tag, error: r.message ?? 'broadcast failed' });
      }
    } catch (e) {
      out.failed.push({ slot: tag, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
