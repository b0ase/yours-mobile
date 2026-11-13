/**
 * The balance card's truth lines (plan fix 5, 13 Nov 2026; owner's account boase@bwalletX.com).
 *
 * The headline stays the figure the wallet can spend now (services/depositBalance.ts balanceSplit). Under it, one small
 * line each, shown only when it applies:
 *  - "Held by an unsent payment: X": coins set aside by a payment this device signed (or started) and never sent
 *    (status nosend, unsigned or unprocessed, older than UNSENT_GRACE_MS). X is what that payment keeps out of the
 *    headline: its inputs, less any change of its own the headline already counts (the toolbox's balance counts a
 *    nosend payment's spendable change, inFlightChangeSats an unprocessed one's). The 6 Nov incident: theme payments
 *    signed noSend on the extension held coins for days and nothing on the card said so.
 *  - "Arriving from your other device: Y": coins the backup holds as spendable that this device keeps back until the
 *    chain confirms them (services/inboundSync.ts admission list). Not in the headline yet. One whose spender the receive
 *    guard already counts as arriving (receiveGuard.ts, spender-tagged) is left out: the headline holds it.
 *  - "Synced with your other devices N min ago": the last device-sync pull that went through (deviceSync.ts onPull,
 *    persisted per account in chrome.storage.local). Red "Not synced since <date>" after STALE_SYNC_MS, or while a pull
 *    from the start has stopped moving (fullPass.ts stuckMs; the extension's froze on 8 Nov). Hidden with no backup.
 *
 * Display only: everything here reads; nothing decides what is signed, sent or spent.
 */

/** A payment younger than this is still on its way (a Store payment is signed noSend, then sent in seconds). */
export const UNSENT_GRACE_MS = 2 * 60_000;
/** The sync line turns red when the last good pull is older than this. */
export const STALE_SYNC_MS = 6 * 3_600_000;
/** A pull from the start that has not moved for this long (fullPass.ts stuckMs, wallet uptime) reads as stuck. */
export const STUCK_SHOW_MS = 10 * 60_000;
/** The statuses whose inputs are set aside but which have not gone out. */
export const UNSENT_STATUSES = ['nosend', 'unsigned', 'unprocessed'] as const;

export type HeldPayment = {
  txid: string;
  description: string;
  status: string;
  /** What this payment keeps out of the headline (satoshis). */
  sats: number;
  createdAt: number;
};

/** The last device-sync pulls, as persisted (DEVICE_SYNC_KEY). */
export type DeviceSyncHealth = {
  /** The last pull that went through and was not a stuck pass from the start (ms). */
  okAt?: number;
  /** The first failed pull since the last good one (ms). */
  failingSince?: number;
  /** The last pull went through, but its pass from the start has stopped moving. */
  stuck?: boolean;
  error?: string;
};

export const DEVICE_SYNC_KEY = (identityAddress: string) => `deviceSyncPull:${identityAddress}`;

/** The next persisted record after a pull (ok, stuck or failed). */
export function nextDeviceSyncHealth(
  prev: DeviceSyncHealth | undefined,
  r: { ok: true; stuck?: boolean } | { ok: false; error: string },
  now: number,
): DeviceSyncHealth {
  const p = prev && typeof prev === 'object' ? prev : {};
  if (r.ok && !r.stuck) return { okAt: now };
  if (r.ok) return { ...(p.okAt ? { okAt: p.okAt } : {}), stuck: true };
  return {
    ...(p.okAt ? { okAt: p.okAt } : {}),
    ...(p.stuck ? { stuck: true } : {}),
    failingSince: p.failingSince ?? now,
    error: r.error,
  };
}

/** What the background answers to BALANCE_TRUTH. */
export type BalanceTruth = {
  held: HeldPayment[];
  arrivingSats: number;
  /** This device's store is active and a backup is configured: the sync line applies. */
  syncApplies: boolean;
  sync?: DeviceSyncHealth | null;
};

export type TruthLine =
  | { kind: 'held'; text: string; sats: number; payments: HeldPayment[] }
  | { kind: 'arriving'; text: string; sats: number }
  | { kind: 'sync'; text: string; warn: boolean };

const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ago`;
};

/** "8 Nov, 14:05" (the year only when it is not this year's). */
export const shortDate = (at: number, now: number): string => {
  const d = new Date(at);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()} ${month}${year}, ${hm}`;
};

/** The sync line, or null when it doesn't apply or nothing is known yet. */
export function syncLine(t: Pick<BalanceTruth, 'syncApplies' | 'sync'>, now: number): TruthLine | null {
  if (!t.syncApplies || !t.sync) return null;
  const { okAt, stuck, failingSince } = t.sync;
  if (!okAt) {
    // Never a good pull on record: say so only once it has failed (or stuck) for the stale window.
    const since = failingSince ?? (stuck ? now : undefined);
    if (stuck || (since !== undefined && now - since >= STALE_SYNC_MS))
      return { kind: 'sync', text: 'Not synced with your other devices yet', warn: true };
    return null;
  }
  if (stuck || now - okAt >= STALE_SYNC_MS)
    return { kind: 'sync', text: `Not synced since ${shortDate(okAt, now)}`, warn: true };
  return { kind: 'sync', text: `Synced with your other devices ${ago(Math.max(0, now - okAt))}`, warn: false };
}

/**
 * The lines to show, in order: held, arriving, sync. `fmt` turns satoshis into the card's unit ("$1.20" or
 * "120,000 sats"). `hideAmounts` (balance hidden): the money lines are left out; the sync line stays.
 */
export function truthLines(
  t: BalanceTruth | null | undefined,
  fmt: (sats: number) => string,
  now: number,
  o: { hideAmounts?: boolean } = {},
): TruthLine[] {
  if (!t) return [];
  const lines: TruthLine[] = [];
  const held = (t.held ?? []).filter((p) => p.sats > 0);
  const heldSats = held.reduce((s, p) => s + p.sats, 0);
  if (!o.hideAmounts && heldSats > 0)
    lines.push({
      kind: 'held',
      text: `Held by ${held.length === 1 ? 'an unsent payment' : `${held.length} unsent payments`}: ${fmt(heldSats)}`,
      sats: heldSats,
      payments: held,
    });
  const arriving = Math.max(0, Math.round(t.arrivingSats || 0));
  if (!o.hideAmounts && arriving > 0)
    lines.push({ kind: 'arriving', text: `Arriving from your other device: ${fmt(arriving)}`, sats: arriving });
  const s = syncLine(t, now);
  if (s) lines.push(s);
  return lines;
}

// ── The background's reads (device store, read only) ──

type TxRow = {
  transactionId: number;
  txid?: string | null;
  status?: string;
  description?: string;
  created_at?: Date | string | number;
};
type OutRow = {
  satoshis?: number;
  spendable?: boolean;
  change?: boolean;
  spentBy?: number | null;
  transactionId?: number;
};

/** The StorageIdb reads used here (straight from the active device store, never through the manager's locks). */
export type TruthStore = {
  findTransactions(args: { partial: { userId: number; status?: string }; noRawTx?: boolean }): Promise<TxRow[]>;
  findOutputs(args: {
    partial: { userId?: number; spentBy?: number; transactionId?: number; txid?: string; vout?: number };
    noScript?: boolean;
  }): Promise<OutRow[]>;
};

const ms = (v: TxRow['created_at']) => (v instanceof Date ? v.getTime() : v == null ? NaN : new Date(v).getTime());

/**
 * This account's payments that hold coins and have not gone out (UNSENT_STATUSES, older than UNSENT_GRACE_MS), newest
 * first, each with what it keeps out of the headline. Reads only.
 */
export async function heldPayments(store: TruthStore, userId: number, now: number): Promise<HeldPayment[]> {
  const out: HeldPayment[] = [];
  for (const status of UNSENT_STATUSES)
    for (const t of await store.findTransactions({ partial: { userId, status }, noRawTx: true })) {
      const at = ms(t.created_at);
      // An unknown time counts as old: a payment that holds coins is never hidden for lack of a date.
      if (Number.isFinite(at) && now - at < UNSENT_GRACE_MS) continue;
      // By index: the inputs it spends, and its own outputs (spentBy / transactionId, no user scan).
      const inputs = await store.findOutputs({ partial: { spentBy: t.transactionId }, noScript: true });
      const own = await store.findOutputs({ partial: { transactionId: t.transactionId }, noScript: true });
      const spent = inputs.reduce((s, o) => s + (o.satoshis || 0), 0);
      const counted = own
        .filter((o) => o.spendable === true && o.change === true)
        .reduce((s, o) => s + (o.satoshis || 0), 0);
      const sats = Math.max(0, spent - counted);
      if (sats <= 0) continue;
      out.push({
        txid: t.txid ?? '',
        description: (t.description ?? '').trim(),
        status: t.status ?? status,
        sats,
        createdAt: Number.isFinite(at) ? at : 0,
      });
    }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** An admission-list entry (services/inboundSync.ts PendingAdmission), as much as this needs. */
export type AdmissionEntry = { kind: 'coin' | 'tx'; txid: string; vout?: number };

/**
 * Coins on the admission list that this device holds as not spendable yet (and not spent), less those whose transaction
 * the receive guard already counts as arriving (`countedSpenders`: the spenders its arriving entries are tagged with).
 */
export async function arrivingFromAdmissions(
  store: TruthStore,
  userId: number,
  entries: AdmissionEntry[],
  countedSpenders: Iterable<string | undefined>,
): Promise<number> {
  const counted = new Set([...countedSpenders].filter((s): s is string => !!s).map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    if (e.kind !== 'coin' || typeof e.vout !== 'number' || !e.txid) continue;
    const key = `${e.txid.toLowerCase()}.${e.vout}`;
    if (seen.has(key) || counted.has(e.txid.toLowerCase())) continue;
    seen.add(key);
    const rows = await store.findOutputs({ partial: { userId, txid: e.txid, vout: e.vout }, noScript: true });
    const row = rows.find((r) => r.spendable !== true && r.spentBy == null);
    // Spendable already (admitted since the list was read) or spent: not arriving.
    if (!row || rows.some((r) => r.spendable === true)) continue;
    total += row.satoshis || 0;
  }
  return total;
}
