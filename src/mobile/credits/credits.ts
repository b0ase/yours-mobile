/**
 * bCredits ($BCREDIT) — pure state for the Wallet tab's Credits row and Top up sheet.
 *
 * Credits are for using bCorp apps. They don't pay dividends and can't be cashed out.
 * Server: bit-sign feat/credits (docs/CREDITS.md). Top up = send N $BCREDIT to the treasury
 * with the wallet's normal approval, then post the txid; bit-sign verifies it on the 1Sat
 * indexer and credits the in-app balance. Apps debit that balance off-chain. Spent credits
 * stay in the treasury (no burn).
 */

export const CREDITS_TERMS = "Credits are for using bCorp apps. They don't pay dividends and can't be cashed out.";

export interface CreditsInfo {
  enabled: boolean;
  tokenId: string | null;
  treasury: string | null;
  priceSats: number | null;
  decimals: number;
  balance: number;
}

export interface CreditEntry {
  id: string;
  kind: 'deposit' | 'debit';
  app: string | null;
  action: string | null;
  units: number;
  txid: string | null;
  balanceAfter: number;
  createdAt: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** GET /api/bitsign/credits → CreditsInfo. Anything malformed reads as "coming soon". */
export function parseCreditsInfo(data: unknown): CreditsInfo {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const tokenId = str(o.tokenId);
  const treasury = str(o.treasury);
  const price = typeof o.priceSats === 'number' && o.priceSats > 0 && Number.isFinite(o.priceSats) ? o.priceSats : null;
  return {
    enabled: o.enabled === true && !!tokenId && !!treasury,
    tokenId,
    treasury,
    priceSats: price,
    decimals: int(o.decimals) ?? 0,
    balance: int(o.balance) ?? 0,
  };
}

export function parseLedger(data: unknown): CreditEntry[] {
  const rows = (data && typeof data === 'object' ? (data as { entries?: unknown }).entries : null) ?? [];
  if (!Array.isArray(rows)) return [];
  const out: CreditEntry[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || (r.kind !== 'deposit' && r.kind !== 'debit')) continue;
    const units = int(r.units);
    if (!units) continue;
    out.push({
      id: String(r.id ?? out.length),
      kind: r.kind,
      app: str(r.app),
      action: str(r.action),
      units,
      txid: str(r.txid),
      balanceAfter: int(r.balanceAfter) ?? 0,
      createdAt: str(r.createdAt) ?? '',
    });
  }
  return out;
}

export const entryLabel = (e: CreditEntry) =>
  e.kind === 'deposit' ? 'Top up' : [e.app, e.action].filter(Boolean).join(' · ') || 'Used';

export const entryAmount = (e: CreditEntry) => `${e.kind === 'deposit' ? '+' : '−'}${e.units.toLocaleString('en-US')}`;

/** Top-up cost in sats at the fixed price, or null when no price is set. */
export const topUpCost = (credits: number, priceSats: number | null) =>
  priceSats && Number.isInteger(credits) && credits > 0 ? Math.ceil(credits * priceSats) : null;

/** Whole credits → raw token units for sendBsv21. */
export const rawAmount = (credits: number, decimals: number) => BigInt(credits) * BigInt(10) ** BigInt(decimals);

export const MAX_TOP_UP = 1_000_000;

/** Parse the amount box. Returns the credit count or a reason. */
export function parseAmount(input: string): { ok: true; credits: number } | { ok: false; error: string } {
  const t = input.trim().replace(/,/g, '');
  if (!/^\d+$/.test(t)) return { ok: false, error: 'Enter a whole number of credits' };
  const n = Number(t);
  if (n < 1) return { ok: false, error: 'At least 1 credit' };
  if (n > MAX_TOP_UP) return { ok: false, error: `At most ${MAX_TOP_UP.toLocaleString('en-US')} at a time` };
  return { ok: true, credits: n };
}

/** Can the wallet send this top-up? `heldRaw` = this wallet's $BCREDIT balance in raw units. */
export function topUpCheck(info: CreditsInfo, credits: number, heldRaw: bigint | null): string | null {
  if (!info.enabled || !info.tokenId || !info.treasury) return 'Credits are coming soon';
  if (heldRaw === null) return null; // unknown; the wallet's own send will refuse if short
  if (rawAmount(credits, info.decimals) > heldRaw) return "You don't have that many $BCREDIT in this wallet";
  return null;
}

// ── Top-ups sent but not yet credited (the indexer may lag) ──

export type Pending = { txid: string; credits: number; at: number }[];

export const addPending = (p: Pending, txid: string, credits: number, now = Date.now()): Pending =>
  p.some((x) => x.txid === txid) ? p : [...p, { txid, credits, at: now }];

export const removePending = (p: Pending, txid: string): Pending => p.filter((x) => x.txid !== txid);

/** Drop pending entries older than a week; they'll never index and just clutter the row. */
export const prunePending = (p: Pending, now = Date.now()) => p.filter((x) => now - x.at < 7 * 86_400_000);

export type DepositOutcome = 'credited' | 'pending' | 'failed';

/** POST deposit response → outcome. 202 / {pending:true} means retry later. */
export function depositOutcome(status: number, body: unknown): DepositOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as { pending?: unknown; balance?: unknown };
  if (status === 202 || b.pending === true) return 'pending';
  if (status >= 200 && status < 300 && typeof b.balance === 'number') return 'credited';
  return 'failed';
}

const PENDING_KEY = 'bwallet.credits.pending';
export const loadPending = (): Pending => {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? prunePending(v.filter((x) => x && typeof x.txid === 'string')) : [];
  } catch {
    return [];
  }
};
export const savePending = (p: Pending) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
};
