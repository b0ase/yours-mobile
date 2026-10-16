/**
 * Import the people you follow on X (site /invite; server = bit-sign PR #295, off by default).
 *
 * GET    /api/bitsign/me/x-follows/import/estimate → what an import would fetch and cost (no X call)
 * POST   /api/bitsign/me/x-follows/import          → { imported, matched: [{ handle, x_username }], capped }
 * GET    /api/bitsign/me/x-follows                 → the stored result
 * DELETE /api/bitsign/me/x-follows                 → remove the imported list (the cooldown stays)
 *
 * Every route answers 404 { code: 'disabled' } until the owner turns it on, so the wallet shows
 * nothing. Paying for the import (about $0.01 per account) is the owner's decision and isn't wired:
 * a 402 from the server is shown as "coming", never as a payment flow.
 */
import { BCHAT_ORIGIN, ChatApiError } from './api';

export type XFollowsCaller = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

export const ESTIMATE_PATH = '/api/bitsign/me/x-follows/import/estimate';
export const IMPORT_PATH = '/api/bitsign/me/x-follows/import';
export const FOLLOWS_PATH = '/api/bitsign/me/x-follows';

export interface XFollowsEstimate {
  accounts: number;
  estimatedUsd: number;
  usdPerAccount: number;
  maxPerImport: number;
  capped: boolean;
  allowed: boolean;
  reason: string;
  followingCount: number;
  cooldownUntil: string | null;
  hasScope: boolean;
  reauthUrl: string | null;
}

export interface XFollowMatch {
  handle: string;
  xUsername: string;
}

export interface XFollowsResult {
  imported: number;
  matched: XFollowMatch[];
  capped: boolean;
  lastImportAt: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Relative reauth links resolve against bit-sign; only https links are opened. */
export const absoluteUrl = (u: unknown, origin = BCHAT_ORIGIN): string | null => {
  const s = str(u).trim();
  if (!s) return null;
  try {
    const url = new URL(s, origin);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

export function parseEstimate(v: unknown): XFollowsEstimate {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    accounts: num(o.accounts),
    estimatedUsd: num(o.estimated_usd),
    usdPerAccount: num(o.usd_per_account),
    maxPerImport: num(o.max_per_import),
    capped: o.capped === true,
    allowed: o.allowed === true,
    reason: str(o.reason) || 'ok',
    followingCount: num(o.following_count),
    cooldownUntil: str(o.cooldown_until) || null,
    hasScope: o.has_scope === true,
    reauthUrl: absoluteUrl(o.reauth_url),
  };
}

export function parseMatches(v: unknown): XFollowMatch[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: XFollowMatch[] = [];
  for (const x of v) {
    const o = (x ?? {}) as Record<string, unknown>;
    const handle = str(o.handle).replace(/^\$/, '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{1,50}$/.test(handle) || seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, xUsername: str(o.x_username).replace(/^@/, '') });
  }
  return out;
}

export function parseResult(v: unknown): XFollowsResult {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    imported: num(o.imported),
    matched: parseMatches(o.matched),
    capped: o.capped === true,
    lastImportAt: str(o.last_import_at) || null,
  };
}

// ── plain words ──

export const usd = (n: number) => (n > 0 && n < 0.01 ? 'under 1¢' : `$${n.toFixed(2)}`);

export const day = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

/** The estimate as short sentences: accounts, cost, cap, cooldown. */
export function estimateLines(e: XFollowsEstimate): string[] {
  const lines: string[] = [];
  if (e.followingCount > 0) lines.push(`You follow ${e.followingCount.toLocaleString()} accounts on X.`);
  if (e.accounts > 0) {
    lines.push(
      `We'd look up ${e.accounts.toLocaleString()} of them. X charges about ${usd(e.estimatedUsd)} for that` +
        (e.usdPerAccount > 0 ? ` (${usd(e.usdPerAccount)} each).` : '.'),
    );
  }
  if (e.capped && e.maxPerImport > 0)
    lines.push(`One import covers up to ${e.maxPerImport.toLocaleString()} accounts.`);
  if (e.cooldownUntil) lines.push(`You can import again on ${day(e.cooldownUntil)}.`);
  else lines.push('You can import once every 30 days.');
  return lines;
}

/** Why the import can't run right now, or null when it can. */
export function blockedReason(e: XFollowsEstimate): string | null {
  if (e.allowed) return null;
  if (e.reason === 'cooldown' || e.cooldownUntil)
    return e.cooldownUntil
      ? `One import every 30 days. Next one on ${day(e.cooldownUntil)}.`
      : 'One import every 30 days.';
  if (e.reason === 'monthly_cap_disabled' || e.reason === 'monthly_cap_reached')
    return 'X follow import is full for this month. Try again next month.';
  return 'X follow import is not available right now.';
}

export type XFollowsError =
  | { kind: 'disabled' }
  | { kind: 'signed_out' }
  | { kind: 'no_x'; message: string }
  | { kind: 'scope'; message: string; reauthUrl: string | null }
  | { kind: 'cooldown'; message: string }
  | { kind: 'cap'; message: string }
  | { kind: 'payment'; message: string }
  | { kind: 'x_down'; message: string }
  | { kind: 'other'; message: string };

/** Server refusals → plain messages. */
export function explainError(e: unknown): XFollowsError {
  if (!(e instanceof ChatApiError)) return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
  const data = (e.data ?? {}) as Record<string, unknown>;
  const code = str(data.code);
  if (e.status === 404) return { kind: 'disabled' };
  if (e.status === 401) return { kind: 'signed_out' };
  if (e.status === 409 && code === 'no_x')
    return { kind: 'no_x', message: 'Connect your X account first (Settings › Sign-ins), then try again.' };
  if (e.status === 409 && code === 'scope_missing')
    return {
      kind: 'scope',
      message: 'Allow X to share who you follow, then come back and try again.',
      reauthUrl: absoluteUrl(data.reauth_url),
    };
  if (e.status === 429 && code === 'cooldown') {
    const until = day(str(data.cooldown_until) || null);
    return {
      kind: 'cooldown',
      message: until ? `One import every 30 days. Next one on ${until}.` : 'One import every 30 days.',
    };
  }
  if (e.status === 429 && (code === 'monthly_cap_disabled' || code === 'monthly_cap_reached'))
    return { kind: 'cap', message: 'X follow import is full for this month. Try again next month.' };
  if (e.status === 429) return { kind: 'cooldown', message: 'Slow down. Try again in a minute.' };
  if (e.status === 402) return { kind: 'payment', message: 'Paying for the import is coming soon.' };
  if (e.status === 502) return { kind: 'x_down', message: 'X did not answer. Try again shortly.' };
  return { kind: 'other', message: e.message || 'Something went wrong. Try again.' };
}

export class XFollowsApi {
  constructor(private readonly call: XFollowsCaller) {}

  async estimate(): Promise<XFollowsEstimate> {
    return parseEstimate(await this.call('GET', ESTIMATE_PATH));
  }

  async runImport(): Promise<XFollowsResult> {
    return parseResult(await this.call('POST', IMPORT_PATH, {}));
  }

  async result(): Promise<XFollowsResult> {
    return parseResult(await this.call('GET', FOLLOWS_PATH));
  }

  async remove(): Promise<void> {
    await this.call('DELETE', FOLLOWS_PATH);
  }
}
