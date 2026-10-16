import type { ImportEntry } from '../wallet/abookParse';

/**
 * Sign in with HandCash (owner, 15 Oct 2026): the pure parts, kept free of Capacitor so they are testable.
 * The flow itself is handcashLogin.ts. bit-sign's native contract (RFC 8252 + PKCE, bit-sign #283 allows
 * bwalletx:): only the challenge goes to the server, the deep link carries a sealed grant, and the grant is
 * exchanged with the verifier over HTTPS for {auth_token, handle}. auth_token is the raw HandCash token.
 */

/** bChatX's door on bit-sign: its HandCash consent screen and accounts. */
export const HANDCASH_ORIGIN = 'https://www.bchatx.com';
/** Where bit-sign sends the grant. Must match at /api/auth/handcash and /api/auth/native/exchange. */
export const HANDCASH_REDIRECT = 'bwalletx://auth/handcash';

export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** 32 random bytes → 43 base64url chars (the RFC 7636 minimum, which bit-sign checks). */
export const makeVerifier = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const challengeFor = async (verifier: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

export const authorizeUrl = (challenge: string, origin = HANDCASH_ORIGIN): string =>
  `${origin}/api/auth/handcash?mode=native&redirect=${encodeURIComponent(HANDCASH_REDIRECT)}` +
  `&code_challenge=${encodeURIComponent(challenge)}`;

export const isHandCashReturn = (url: string) => url.startsWith(HANDCASH_REDIRECT);

/** The grant (or the server's error) from the deep link bit-sign ended on. */
export const parseReturn = (url: string): { grant: string } | { error: string } => {
  const q = new URLSearchParams(url.split('?')[1]?.split('#')[0] || '');
  const grant = q.get('grant');
  if (grant) return { grant };
  return { error: q.get('error') || 'HandCash sign-in did not finish. Please try again.' };
};

export type HandCashFriend = { handle: string; display_name?: string; avatar_url?: string };

/** Why the friends list couldn't be fetched: `signin` means sign in with HandCash again. */
export type FriendsProblem = 'signin' | 'no_handcash' | 'no_permission' | 'failed';

export const friendsProblem = (status: number): FriendsProblem =>
  status === 401 ? 'signin' : status === 409 ? 'no_handcash' : status === 403 ? 'no_permission' : 'failed';

export const friendsProblemText: Record<FriendsProblem, string> = {
  signin: 'Your HandCash sign-in has expired. Sign in with HandCash again to bring in your friends.',
  no_handcash: 'No HandCash account is linked yet. Sign in with HandCash first.',
  no_permission: "HandCash didn't give permission to read your friends. Sign in with HandCash again and allow it.",
  failed: "Couldn't reach HandCash just now. Please try again.",
};

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** HandCash friends → the Address book import preview's entries (handle@handcash.io), deduplicated. */
export const friendsToEntries = (friends: HandCashFriend[]): ImportEntry[] => {
  const seen = new Set<string>();
  const out: ImportEntry[] = [];
  for (const fr of friends) {
    const h = String(fr?.handle || '')
      .trim()
      .replace(/^\$/, '')
      .toLowerCase();
    if (!HANDLE.test(h) || seen.has(h)) continue;
    seen.add(h);
    const paymail = `${h}@handcash.io`;
    out.push({ raw: paymail, paymail, handle: null, name: String(fr.display_name || '').trim(), notes: '' });
  }
  return out;
};
