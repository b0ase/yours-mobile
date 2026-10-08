/**
 * Token room admin = the proven issuer. When this wallet holds the issuer key and the room has
 * no claimed issuer (or someone else claimed it), prove it in the background: fetch bit-sign's
 * challenge, check it is exactly the room-admin challenge for THIS room and THIS account, sign
 * it with the issuer key and submit. No prompt: it is the user's own key proving a public fact.
 *
 * At most once per room per account per session; a network failure (status 0) allows a later
 * retry. Nothing is ever signed unless the challenge passes `isIssuerChallenge`.
 */
import type { IssuerChallenge } from './api';
import type { Derivation } from './tokenRooms';

/** bit-sign's lib/room-issuer.ts claimMessage(): `bitcoinchat.online room admin: <key>: $<handle>: <ts>`. */
const CHALLENGE_RE = /^bitcoinchat\.online room admin: (.+): \$([a-z0-9._-]+): (\d{9,11})$/;
/** bit-sign accepts a claim within 10 minutes; allow a little clock skew either way. */
const MAX_AGE_S = 10 * 60;
const SKEW_S = 5 * 60;

const norm = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();

/** Is `message` the issuer challenge for this room and this account, and fresh? */
export function isIssuerChallenge(
  message: string | null | undefined,
  roomKey: string,
  me: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof message !== 'string' || message.length > 300 || !roomKey || !me) return false;
  const m = CHALLENGE_RE.exec(message);
  if (!m) return false;
  if (m[1] !== roomKey || m[2] !== norm(me)) return false;
  const ts = Number(m[3]);
  return ts <= nowS + SKEW_S && ts >= nowS - MAX_AGE_S - SKEW_S;
}

/** Decision: claim only when unclaimed-by-us, an issuer address exists and this wallet holds its key. */
export function shouldAutoClaim(ch: IssuerChallenge, me: string, holdsKey: boolean): boolean {
  if (!holdsKey || !ch.issuerAddress || ch.youAreIssuer) return false;
  if (ch.claimedBy && norm(ch.claimedBy) === norm(me)) return false;
  return true;
}

/** An admin-only action refused (403) by a server that wants the issuer claim. */
export function isAdminRefusal(e: unknown): boolean {
  const err = e as { status?: unknown; data?: unknown; message?: unknown } | null;
  if (!err || err.status !== 403) return false;
  const code = (err.data as { code?: unknown } | null)?.code;
  if (code === 'not_host' || code === 'not_admin' || code === 'not_issuer') return true;
  return typeof err.message === 'string' && /admin|issuer|host/i.test(err.message);
}

export interface ClaimDeps {
  issuerChallenge: (ticker: string) => Promise<IssuerChallenge>;
  claimIssuer: (ticker: string, message: string, signature: string) => Promise<void>;
  findKey: (address: string) => Promise<Derivation | null>;
  sign: (key: Derivation, message: string) => Promise<string>;
}

export type ClaimResult = 'claimed' | 'already' | 'not-issuer' | 'skipped' | 'failed';

const attempted = new Set<string>();
const listeners = new Set<(ticker: string) => void>();

/** Notified after a successful claim (so banners/sheets re-read admin state). */
export function onIssuerClaimed(fn: (ticker: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Test hook. */
export function resetAutoClaim(): void {
  attempted.clear();
}

/** The claim flow. `force` (the inline "Claim admin" button) ignores the once-per-session guard. */
export async function claimIssuerAdmin(
  ticker: string,
  me: string,
  deps: ClaimDeps,
  opts: { force?: boolean } = {},
): Promise<ClaimResult> {
  const id = `${norm(me)}|${ticker.toUpperCase()}`;
  if (!me) return 'skipped';
  if (!opts.force && attempted.has(id)) return 'skipped';
  attempted.add(id);
  try {
    const ch = await deps.issuerChallenge(ticker);
    if (ch.youAreIssuer) return 'already';
    if (!ch.issuerAddress) return 'not-issuer';
    const key = await deps.findKey(ch.issuerAddress).catch(() => null);
    if (!shouldAutoClaim(ch, me, !!key) || !key) return 'not-issuer';
    if (!isIssuerChallenge(ch.message, ch.roomKey, me)) return 'failed';
    const message = ch.message as string;
    await deps.claimIssuer(ticker, message, await deps.sign(key, message));
    for (const fn of listeners) fn(ticker);
    return 'claimed';
  } catch (e) {
    // Network failure: let a later open try again.
    if ((e as { status?: unknown } | null)?.status === 0) attempted.delete(id);
    return 'failed';
  }
}
