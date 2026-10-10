import { parseRecipient } from '../../names/names';
import { formatFiat } from '../../../utils/displayCurrency';

/**
 * Pure logic for the Send card (SendCard.tsx): dollar amounts, the one Send button's wording,
 * paste detection and the recent-recipients list. No React, no network.
 */

export const SATS_PER_BSV = 100_000_000;
export const QUICK_USD = [1, 5, 10, 20] as const;

export type SendRow = {
  id: string;
  address: string;
  satSendAmount: number | null;
  usdSendAmount: number | null;
  amountType: 'bsv' | 'usd';
};

/** What the recipient box is doing (NameInput). */
export type RowStatus = 'empty' | 'typing' | 'loading' | 'error' | 'ready';

/** Satoshis a row will send (USD rows converted at `rate`, rounded up like handleSendBsv). */
export const rowSats = (r: SendRow, rate: number): number => {
  if (r.satSendAmount && r.satSendAmount > 0) return r.satSendAmount;
  if (r.usdSendAmount && r.usdSendAmount > 0 && rate > 0) return Math.ceil((r.usdSendAmount / rate) * SATS_PER_BSV);
  return 0;
};

export const rowUsd = (r: SendRow, rate: number): number => {
  if (r.usdSendAmount && r.usdSendAmount > 0) return r.usdSendAmount;
  if (r.satSendAmount && r.satSendAmount > 0) return (r.satSendAmount / SATS_PER_BSV) * rate;
  return 0;
};

/** Dollars shown in the display currency (Settings › Currency). */
export const fmtUsd = (n: number): string => formatFiat(n);

export const fmtBsv = (sats: number): string => {
  const bsv = sats / SATS_PER_BSV;
  // Trim trailing zeros but keep at least 3 decimals, like the balance line.
  const s = bsv.toFixed(8).replace(/0+$/, '');
  const [i, d = ''] = s.split('.');
  return `${i}.${d.padEnd(3, '0')}`;
};

export const fmtSats = (sats: number): string => `${Math.round(sats).toLocaleString('en-US')} sats`;

/** "$2.77 · 0.148 BSV" (USD part dropped while the rate is unknown). */
export const balanceLine = (balanceBsv: number, rate: number): string => {
  const sats = Math.round(balanceBsv * SATS_PER_BSV);
  return rate > 0 ? `${fmtUsd(balanceBsv * rate)} · ${fmtBsv(sats)} BSV` : `${fmtBsv(sats)} BSV`;
};

/**
 * Parse what was typed in the big amount field. Accepts "5", "5.5", ".5", "$5", "1,000.25".
 * Returns null for empty / not a number; never negative.
 */
export const parseAmount = (raw: string): number | null => {
  const s = raw.replace(/[$£€,\s]/g, '');
  if (!s || s === '.') return null;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export type ButtonState = { label: string; disabled: boolean };

/**
 * The single Send button: says exactly what will happen, or exactly what is missing.
 * `names[id]` is the friendly name of a row's recipient ($alice) when it was resolved.
 */
export const sendButton = (p: {
  rows: SendRow[];
  status: Record<string, RowStatus>;
  names: Record<string, string>;
  rate: number;
  balanceBsv: number;
  sendAll: boolean;
  processing?: boolean;
}): ButtonState => {
  if (p.processing) return { label: 'Sending…', disabled: true };
  const multi = p.rows.length > 1;
  for (const [i, r] of p.rows.entries()) {
    const who = multi ? ` for recipient ${i + 1}` : '';
    const st = p.status[r.id] ?? (r.address ? 'ready' : 'empty');
    if (st === 'loading') return { label: 'Looking up recipient…', disabled: true };
    if (st === 'error') return { label: `Check the recipient${who}`, disabled: true };
    if (!r.address) return { label: multi ? `Choose recipient ${i + 1}` : 'Choose who to pay', disabled: true };
    if (rowSats(r, p.rate) <= 0) return { label: `Enter an amount${who}`, disabled: true };
  }
  const sats = p.sendAll ? Math.round(p.balanceBsv * SATS_PER_BSV) : p.rows.reduce((a, r) => a + rowSats(r, p.rate), 0);
  if (sats > Math.round(p.balanceBsv * SATS_PER_BSV)) return { label: 'Not enough balance', disabled: true };
  const amount = p.rate > 0 ? fmtUsd((sats / SATS_PER_BSV) * p.rate) : `${fmtBsv(sats)} BSV`;
  const first = p.rows[0];
  const to = multi ? `${p.rows.length} people` : (p.names[first.id] ?? shortTarget(first.address));
  return { label: `Send ${amount} to ${to}`, disabled: false };
};

export const shortTarget = (s: string): string => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** Clipboard text worth dropping into the recipient box: an address, $handle, paymail or name. */
export const pastedRecipient = (raw: string | null | undefined): string | null => {
  const s = (raw ?? '').trim();
  if (!s || s.length > 120 || /\s/.test(s)) return null;
  // bitcoin:/payto URIs: take the address part.
  const uri = s.match(/^(?:bitcoin|bsv):([^?]+)/i);
  const v = uri ? uri[1] : s;
  const k = parseRecipient(v).kind;
  return k === 'empty' || k === 'invalid' ? null : v;
};

/* ── Recent recipients ─────────────────────────────────────────────────────────────── */

export type RecentRecipient = {
  /** What goes in the recipient box: $handle, paymail, name or address. */
  input: string;
  label: string;
  avatar?: string;
  at: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = (acct: string) => `bwallet.send.recents.${acct}`;
export const MAX_RECENTS = 8;

const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const loadRecents = (acct: string, s: Store | null = storage()): RecentRecipient[] => {
  if (!acct || !s) return [];
  try {
    const v = JSON.parse(s.getItem(KEY(acct)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.input === 'string' && typeof x.label === 'string') : [];
  } catch {
    return [];
  }
};

/** Newest first, de-duplicated by input (case-insensitive), capped at MAX_RECENTS. */
export const addRecents = (list: RecentRecipient[], add: RecentRecipient[]): RecentRecipient[] => {
  const seen = new Set<string>();
  const out: RecentRecipient[] = [];
  for (const r of [...add, ...list]) {
    const k = r.input.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.slice(0, MAX_RECENTS);
};

// Resolved names seen in the Send card, keyed by the destination handed to the send code
// (paymail or address), so a successful send can be remembered under its friendly name.
const pending = new Map<string, Omit<RecentRecipient, 'at'>>();
export const notePending = (target: string, meta: Omit<RecentRecipient, 'at'>) => {
  if (target) pending.set(target, meta);
};

/** After a successful send: remember who was paid. `targets` are the paymails / addresses sent to. */
export const rememberSent = (acct: string, targets: string[], now = Date.now(), s: Store | null = storage()) => {
  if (!acct || !s) return;
  const add = targets.filter(Boolean).map((t) => {
    const m = pending.get(t);
    return m ? { ...m, at: now } : { input: t, label: shortTarget(t), at: now };
  });
  try {
    s.setItem(KEY(acct), JSON.stringify(addRecents(loadRecents(acct, s), add)));
  } catch {
    /* storage full / blocked: recents are a convenience */
  }
};
