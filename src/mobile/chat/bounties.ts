/**
 * Bounties in a token room — pure state for the Chat tab's Bounties sheet.
 *
 * Server: bit-sign feat/bounty-payouts. Lifecycle open → claimed (PR URL) → merged (GitHub
 * webhook) → paid (the payer's wallet sends, then posts the txid). The server never holds keys:
 * "Pay" fetches a transfer spec and this wallet performs it with its normal approval.
 */

export type BountyStatus = 'open' | 'claimed' | 'merged' | 'paid' | string;

export interface Bounty {
  bounty_no: number;
  title: string;
  status: BountyStatus;
  created_by: string;
  claimed_by: string | null;
  agent_label: string | null;
  payout_kind: 'room_token' | 'bsv' | 'share_class' | null;
  reward: string | null;
  reward_token_raw: string | null;
  reward_sats: number | null;
  github_pr_url: string | null;
  paid_txid: string | null;
}

export type Transfer =
  | { type: 'bsv21'; tokenId: string; symbol: string; dec: number; amountRaw: string; address: string }
  | { type: 'bsv'; sats: number; address: string };

export interface PayoutSpec {
  ticker: string;
  bountyNo: number;
  claimant: string;
  transfers: Transfer[];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;

/** Server rows → Bounty. Only paid-on-merge bounties (payout_kind set) are shown. */
export function parseBounties(data: unknown): Bounty[] {
  const rows = (data && typeof data === 'object' ? (data as { bounties?: unknown }).bounties : null) ?? [];
  if (!Array.isArray(rows)) return [];
  const out: Bounty[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const no = num(r.bounty_no);
    const kind = r.payout_kind;
    if (!no || (kind !== 'room_token' && kind !== 'bsv')) continue;
    if (r.status === 'cancelled') continue;
    out.push({
      bounty_no: no,
      title: str(r.title) ?? `Bounty #${no}`,
      status: str(r.status) ?? 'open',
      created_by: str(r.created_by) ?? '',
      claimed_by: str(r.claimed_by_handle) ?? str(r.claimed_by),
      agent_label: str(r.agent_label),
      payout_kind: kind,
      reward: str(r.reward),
      reward_token_raw: r.reward_token_raw == null ? null : String(r.reward_token_raw),
      reward_sats: num(r.reward_sats),
      github_pr_url: str(r.github_pr_url),
      paid_txid: str(r.paid_txid),
    });
  }
  return out;
}

const ORDER: Record<string, number> = { open: 0, claimed: 1, merged: 2, paid: 3 };
export const sortBounties = (bs: Bounty[]) =>
  [...bs].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.bounty_no - b.bounty_no);

export function formatRaw(raw: string, dec: number): string {
  if (!/^\d+$/.test(raw)) return raw;
  if (!dec) return raw;
  const s = raw.padStart(dec + 1, '0');
  const whole = s.slice(0, -dec);
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function rewardLabel(b: Bounty, token: { symbol: string; dec: number } | null): string {
  const parts: string[] = [];
  if (b.reward_token_raw)
    parts.push(token ? `${formatRaw(b.reward_token_raw, token.dec)} $${token.symbol}` : `${b.reward_token_raw} tokens`);
  if (b.reward_sats) parts.push(`${b.reward_sats.toLocaleString('en-US')} sats`);
  return parts.join(' + ') || b.reward || '—';
}

export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,7}\/?$/;

/** Client-side precheck; the server re-checks (and also that the PR is in the room's repo). */
export function claimCheck(b: Bounty, me: string, prUrl: string): string | null {
  if (b.status !== 'open') return `Already ${b.status}`;
  if (b.created_by === me) return 'You created this bounty';
  if (!PR_URL.test(prUrl.trim())) return 'Paste a github.com/owner/repo/pull/N link';
  return null;
}

/** Show "Pay" on a merged bounty to someone who might be the payer (server decides). */
export const showPay = (b: Bounty, me: string, isAdmin: boolean) =>
  b.status === 'merged' && !b.paid_txid && b.claimed_by !== me && (isAdmin || b.created_by === me);

export function parseSpec(data: unknown): PayoutSpec | null {
  const s = data && typeof data === 'object' ? (data as { spec?: unknown }).spec : null;
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const transfers: Transfer[] = [];
  for (const t of (Array.isArray(o.transfers) ? o.transfers : []) as Record<string, unknown>[]) {
    const address = str(t?.address);
    if (!address) return null;
    if (t.type === 'bsv21' && str(t.tokenId) && /^[1-9]\d*$/.test(String(t.amountRaw))) {
      transfers.push({
        type: 'bsv21',
        tokenId: String(t.tokenId),
        symbol: str(t.symbol) ?? '',
        dec: num(t.dec) ?? 0,
        amountRaw: String(t.amountRaw),
        address,
      });
    } else if (t.type === 'bsv' && (num(t.sats) ?? 0) > 0) {
      transfers.push({ type: 'bsv', sats: num(t.sats)!, address });
    } else return null;
  }
  const bountyNo = num(o.bountyNo);
  if (!transfers.length || !bountyNo || !str(o.claimant)) return null;
  return { ticker: str(o.ticker) ?? '', bountyNo, claimant: String(o.claimant), transfers };
}

export const transferLabel = (t: Transfer) =>
  t.type === 'bsv21' ? `${formatRaw(t.amountRaw, t.dec)} $${t.symbol}` : `${t.sats.toLocaleString('en-US')} sats`;

// ── Notifications: my bounties that became merged / paid since I last looked ──

export type Seen = Record<string, string>; // `${ticker}#${no}` → last status seen

export const seenKey = (ticker: string, no: number) => `${ticker.toUpperCase()}#${no}`;

export function unseenForMe(ticker: string, bs: Bounty[], me: string, seen: Seen): Bounty[] {
  return bs.filter(
    (b) =>
      b.claimed_by === me &&
      (b.status === 'merged' || b.status === 'paid') &&
      seen[seenKey(ticker, b.bounty_no)] !== b.status,
  );
}

export function markSeen(ticker: string, bs: Bounty[], seen: Seen): Seen {
  const next = { ...seen };
  for (const b of bs) next[seenKey(ticker, b.bounty_no)] = b.status;
  return next;
}

const SEEN_KEY = 'bwallet.bchat.bountySeen';
export const loadSeen = (): Seen => {
  try {
    return (JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') as Seen) || {};
  } catch {
    return {};
  }
};
export const saveSeen = (s: Seen) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
};
