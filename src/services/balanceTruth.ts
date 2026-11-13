/**
 * The balance card's truth lines (plan fix 5, 13 Nov 2026; owner's account boase@bwalletX.com).
 *
 * The headline stays the figure the wallet can spend now (services/depositBalance.ts balanceSplit). Under it, one small
 * line each, shown only when it applies:
 *  - "Held by an unsent payment: X": coins set aside by payments this device signed (or started) that have not gone out
 *    (status nosend, unsigned or unprocessed). X is what they keep out of the headline, worked out over the whole held
 *    set so a chain of them (a site's noSend chain: B spends A's change) counts once: inputs from outside the set (an
 *    output one held payment spends from another is internal to the chain), less the set's spendable change, which the
 *    headline counts (the toolbox's balance counts a nosend payment's, inFlightChangeSats an unprocessed one's). An
 *    input the headline already counts as arriving (receive guard) is left out too. A chain whose every payment is
 *    younger than UNSENT_GRACE_MS is still on its way and not shown. The 6 Nov incident: theme payments signed noSend on the extension held coins for days and
 *    nothing on the card said so.
 *  - "Arriving from your other device: Y": coins on the admission list (services/inboundSync.ts) that this device holds
 *    back, not spendable and not spent, until the chain confirms them. Left out: any whose outpoint the receive guard
 *    already counts as arriving (balanceSplit adds those to the headline, tagged or not), and any whose transaction is
 *    the spender an arriving entry is tagged with (the headline holds that value through the entry it spent).
 *  - "Synced with your other devices N min ago": the last device-sync pull that went through (deviceSync.ts onPull,
 *    persisted per account in chrome.storage.local). Red only when something says a pull is not getting through: a
 *    pass from the start that has stopped moving (fullPass.ts passLooksStuck; the extension's froze on 8 Nov), or the
 *    last good pull is STALE_SYNC_MS old AND a pull was tried since and failed (or, from a newer writer, was attempted
 *    and never finished). Age alone is not a fault: pulls run on open and on demand. Hidden with no backup.
 *  - "1 payment's change not backed up yet" (red): a payment went out while the backup could not be reached, and its
 *    change is still only on this device (services/changeWriteAhead.ts, fix 4); gone once a push lands.
 *
 * Display only: everything here reads; nothing decides what is signed, sent or spent.
 */

/** A chain of payments all younger than this is still on its way (a Store payment is signed noSend, sent in seconds). */
export const UNSENT_GRACE_MS = 2 * 60_000;
/** The sync line may turn red when the last good pull is older than this (and a pull since did not get through). */
export const STALE_SYNC_MS = 6 * 3_600_000;
/** An attempt (newer writers' attemptAt) that has not finished well after this long counts as not getting through. */
export const ATTEMPT_OVERDUE_MS = 15 * 60_000;
/** A pass from the start that has not moved for this long (fullPass.ts stuckMs, wallet uptime) reads as stuck. */
export const STUCK_SHOW_MS = 10 * 60_000;
/** The card asks again on a balance change, but at most this often (a live spend moves the balance often). */
export const TRUTH_MIN_GAP_MS = 8_000;
/** Pure: may a balance change ask again now? (At most one ask per TRUTH_MIN_GAP_MS.) */
export const askDue = (lastAskAt: number, now: number, gapMs = TRUTH_MIN_GAP_MS) => now - lastAskAt >= gapMs;
/** The statuses whose inputs are set aside but which have not gone out. */
export const UNSENT_STATUSES = ['nosend', 'unsigned', 'unprocessed'] as const;

export type HeldPayment = {
  /** The earliest payment of the chain. */
  txid: string;
  description: string;
  status: string;
  /** What this payment (with the held payments chained to it) keeps out of the headline (satoshis). */
  sats: number;
  createdAt: number;
  /** Payments in this chain (1 for a lone payment). */
  count: number;
};

/**
 * The last device-sync pulls, as persisted (DEVICE_SYNC_KEY). Other writers (the periodic pull, fix 3) may add fields:
 * they are kept on every write and read only when they are numbers.
 */
export type DeviceSyncHealth = {
  /** The last pull that went through and was not a stuck pass from the start (ms). */
  okAt?: number;
  /** The first failed pull since the last good one (ms). */
  failingSince?: number;
  /** The last pull went through, but its pass from the start has stopped moving. */
  stuck?: boolean;
  error?: string;
  /** When a pull was last started (ms), if the writer records it. */
  attemptAt?: number;
  [other: string]: unknown;
};

export const DEVICE_SYNC_KEY = (identityAddress: string) => `deviceSyncPull:${identityAddress}`;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

const withoutUndefined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as DeviceSyncHealth;

/** The next persisted record after a pull (ok, stuck or failed). Fields this doesn't own are kept. */
export function nextDeviceSyncHealth(
  prev: DeviceSyncHealth | undefined | null,
  r: { ok: true; stuck?: boolean } | { ok: false; error: string },
  now: number,
): DeviceSyncHealth {
  const p: DeviceSyncHealth = prev && typeof prev === 'object' ? prev : {};
  if (r.ok && !r.stuck)
    return withoutUndefined({ ...p, okAt: now, failingSince: undefined, stuck: undefined, error: undefined });
  if (r.ok) return withoutUndefined({ ...p, stuck: true });
  return withoutUndefined({ ...p, failingSince: num(p.failingSince) ?? now, error: r.error });
}

/** What the background answers to BALANCE_TRUTH. */
export type BalanceTruth = {
  held: HeldPayment[];
  arrivingSats: number;
  /** This device's store is active and a backup is configured: the sync line applies. */
  syncApplies: boolean;
  sync?: DeviceSyncHealth | null;
  /**
   * Payments broadcast while the backup was unreachable, whose change (with the derivation that spends it) is still only
   * on this device (services/changeWriteAhead.ts, fix 4). Absent from older wallets.
   */
  changeUnbacked?: number;
};

export type TruthLine =
  | { kind: 'held'; text: string; sats: number; payments: HeldPayment[] }
  | { kind: 'arriving'; text: string; sats: number }
  | { kind: 'sync'; text: string; warn: boolean }
  | { kind: 'backup'; text: string; warn: true };

/** "1 payment's change not backed up yet": a payment whose change is still only on this device. Null when none. */
export function backupLine(t: Pick<BalanceTruth, 'changeUnbacked'>): TruthLine | null {
  const n = typeof t.changeUnbacked === 'number' && t.changeUnbacked > 0 ? Math.floor(t.changeUnbacked) : 0;
  if (!n) return null;
  return {
    kind: 'backup',
    text: n === 1 ? "1 payment's change not backed up yet" : `${n} payments' change not backed up yet`,
    warn: true,
  };
}

const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
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
  if (!t.syncApplies || !t.sync || typeof t.sync !== 'object') return null;
  const okAt = num(t.sync.okAt);
  const failingSince = num(t.sync.failingSince);
  const attemptAt = num(t.sync.attemptAt);
  const stuck = t.sync.stuck === true;
  /** A pull was tried after the last good one and did not get through. */
  const triedSince = (after: number) =>
    (failingSince !== undefined && failingSince >= after) ||
    (attemptAt !== undefined && attemptAt > after && now - attemptAt >= ATTEMPT_OVERDUE_MS);
  if (!okAt) {
    // Never a good pull on record: said only once pulls have been failing (or stuck) for the stale window.
    if (stuck || (failingSince !== undefined && now - failingSince >= STALE_SYNC_MS))
      return { kind: 'sync', text: 'Not synced with your other devices yet', warn: true };
    return null;
  }
  if (stuck || (now - okAt >= STALE_SYNC_MS && triedSince(okAt)))
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
  const count = held.reduce((s, p) => s + Math.max(1, p.count || 1), 0);
  if (!o.hideAmounts && heldSats > 0)
    lines.push({
      kind: 'held',
      text: `Held by ${count === 1 ? 'an unsent payment' : `${count} unsent payments`}: ${fmt(heldSats)}`,
      sats: heldSats,
      payments: held,
    });
  const arriving = Math.max(0, Math.round(t.arrivingSats || 0));
  if (!o.hideAmounts && arriving > 0)
    lines.push({ kind: 'arriving', text: `Arriving from your other device: ${fmt(arriving)}`, sats: arriving });
  const s = syncLine(t, now);
  if (s) lines.push(s);
  const b = backupLine(t);
  if (b) lines.push(b);
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
  txid?: string | null;
  vout?: number;
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

/** "txid.vout", lower case (receiveGuard's normOutpoint form; "txid_vout" accepted). */
export const outpointKey = (op: string) => {
  const o = op.replace('_', '.').toLowerCase();
  return o;
};

/**
 * This account's payments that hold coins and have not gone out (UNSENT_STATUSES), as chains (a payment and the held
 * payments that spend its outputs, or whose outputs it spends), each with what the chain keeps out of the headline.
 * `countedArriving`: outpoints the headline already counts as arriving (receive guard): an input among them is not
 * counted again. Newest first. Reads only.
 */
export async function heldPayments(
  store: TruthStore,
  userId: number,
  now: number,
  countedArriving: Iterable<string> = [],
): Promise<HeldPayment[]> {
  const arriving = new Set([...countedArriving].map(outpointKey));
  const txs: TxRow[] = [];
  for (const status of UNSENT_STATUSES)
    for (const t of await store.findTransactions({ partial: { userId, status }, noRawTx: true }))
      if (typeof t.transactionId === 'number' && !txs.some((x) => x.transactionId === t.transactionId)) txs.push(t);
  if (!txs.length) return [];
  const ids = new Set(txs.map((t) => t.transactionId));
  // By index: each payment's inputs (spentBy) and its own outputs (transactionId); no user scan.
  const inputs = new Map<number, OutRow[]>();
  const outputs = new Map<number, OutRow[]>();
  for (const t of txs) {
    inputs.set(t.transactionId, await store.findOutputs({ partial: { spentBy: t.transactionId }, noScript: true }));
    outputs.set(
      t.transactionId,
      await store.findOutputs({ partial: { transactionId: t.transactionId }, noScript: true }),
    );
  }
  // Chains: union of held payments linked by a spend.
  const parent = new Map<number, number>(txs.map((t) => [t.transactionId, t.transactionId]));
  const root = (id: number): number => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  for (const t of txs)
    for (const i of inputs.get(t.transactionId) ?? [])
      if (typeof i.transactionId === 'number' && ids.has(i.transactionId))
        parent.set(root(t.transactionId), root(i.transactionId));
  // Each payment's share: inputs from outside the held set (one held payment's output spent by another stays inside the
  // chain: counted once, at the chain's outside inputs), not already arriving; less its spendable change, which the
  // headline counts. Summed per chain, so a chain is never counted twice.
  const share = (t: TxRow) => {
    let s = 0;
    for (const i of inputs.get(t.transactionId) ?? []) {
      if (typeof i.transactionId === 'number' && ids.has(i.transactionId)) continue;
      if (i.txid && typeof i.vout === 'number' && arriving.has(`${i.txid.toLowerCase()}.${i.vout}`)) continue;
      s += i.satoshis || 0;
    }
    for (const o of outputs.get(t.transactionId) ?? [])
      if (o.spendable === true && o.change === true) s -= o.satoshis || 0;
    return s;
  };
  const chains = new Map<number, TxRow[]>();
  for (const t of txs) {
    const r = root(t.transactionId);
    chains.set(r, [...(chains.get(r) ?? []), t]);
  }
  const out: HeldPayment[] = [];
  for (const members of chains.values()) {
    const times = members.map((t) => ms(t.created_at));
    // A chain all younger than the grace is still on its way. An unknown time counts as old.
    if (times.every((at) => Number.isFinite(at) && now - at < UNSENT_GRACE_MS)) continue;
    const sats = Math.max(
      0,
      members.reduce((s, t) => s + share(t), 0),
    );
    if (sats <= 0) continue;
    const first = [...members].sort((a, b) => (ms(a.created_at) || 0) - (ms(b.created_at) || 0))[0];
    const at = ms(first.created_at);
    out.push({
      txid: first.txid ?? '',
      description: (first.description ?? '').trim(),
      status: first.status ?? '',
      sats,
      createdAt: Number.isFinite(at) ? at : 0,
      count: members.length,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** An admission-list entry (services/inboundSync.ts PendingAdmission), as much as this needs. */
export type AdmissionEntry = { kind: 'coin' | 'tx'; txid: string; vout?: number };

/**
 * Coins on the admission list that this device holds as not spendable yet (and not spent), less those the headline
 * already counts: any whose outpoint is among the receive guard's arriving entries (`countedArriving`, tagged or not),
 * and any whose transaction is the spender an arriving entry is tagged with (`countedSpenders`).
 */
export async function arrivingFromAdmissions(
  store: TruthStore,
  userId: number,
  entries: AdmissionEntry[],
  counted: { outpoints: Iterable<string>; spenders: Iterable<string | undefined> },
): Promise<number> {
  const spenders = new Set([...counted.spenders].filter((s): s is string => !!s).map((s) => s.toLowerCase()));
  const outpoints = new Set([...counted.outpoints].map(outpointKey));
  const seen = new Set<string>();
  let total = 0;
  for (const e of entries) {
    if (e.kind !== 'coin' || typeof e.vout !== 'number' || !e.txid) continue;
    const key = `${e.txid.toLowerCase()}.${e.vout}`;
    if (seen.has(key) || outpoints.has(key) || spenders.has(e.txid.toLowerCase())) continue;
    seen.add(key);
    const rows = await store.findOutputs({ partial: { userId, txid: e.txid, vout: e.vout }, noScript: true });
    const row = rows.find((r) => r.spendable !== true && r.spentBy == null);
    // Spendable already (admitted since the list was read) or spent: not arriving.
    if (!row || rows.some((r) => r.spendable === true)) continue;
    total += row.satoshis || 0;
  }
  return total;
}
