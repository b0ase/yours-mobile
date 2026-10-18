import { HANDCASH_ORIGIN, challengeFor, makeVerifier, parseReturn } from '../social/handcashCore';

/**
 * "Continue with HandCash" on the web welcome (VITE_SEEDLESS=1): identity only, never keys (HandCash is custodial).
 * Same PKCE contract as the phone app's handcashLogin.ts (bit-sign /api/auth/handcash + /api/auth/native/exchange),
 * but returning to this web origin instead of bwalletx://. Only the verified $handle is kept; the HandCash
 * auth_token is dropped at once (no friends import on web, nothing to leak from localStorage). No app secret here:
 * the HandCash app id/secret live on bit-sign.
 *
 * MISSING SERVER SIDE (docs/SEEDLESS-PASSKEY.md): bit-sign must accept these https redirect URIs for mode=native
 * (today it allows only bwalletx://auth/handcash, bit-sign #283) and send CORS headers on /api/auth/native/exchange
 * for the bwalletx.com web origins. Until then the button returns with an error and the welcome falls back to X /
 * Google / passkey.
 */
const VERIFIER = 'bwx:handcash-web-verifier';
const HANDLE = 'bwx:handcash-web-handle';
export const handcashWebRedirect = (origin = location.origin) => `${origin}/auth/handcash`;
const listeners = new Set<() => void>();
let lastError = '';
export const onHandCashWebChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const handcashWebError = () => lastError;
export const handcashWebHandle = (): string => {
  try {
    return localStorage.getItem(HANDLE) ?? '';
  } catch {
    return '';
  }
};
export const clearHandCashWeb = () => {
  localStorage.removeItem(HANDLE);
  listeners.forEach((l) => l());
};

export const handcashWebAuthorizeUrl = (challenge: string, redirect: string, origin = HANDCASH_ORIGIN) =>
  `${origin}/api/auth/handcash?mode=native&redirect=${encodeURIComponent(redirect)}` +
  `&code_challenge=${encodeURIComponent(challenge)}`;

export async function startHandCashWeb(): Promise<void> {
  lastError = '';
  const verifier = makeVerifier();
  sessionStorage.setItem(VERIFIER, verifier);
  location.assign(handcashWebAuthorizeUrl(await challengeFor(verifier), handcashWebRedirect()));
}

export async function receiveHandCashWeb(url: string, fetcher: typeof fetch = fetch): Promise<string> {
  const verifier = sessionStorage.getItem(VERIFIER);
  sessionStorage.removeItem(VERIFIER);
  const r = parseReturn(url);
  try {
    if ('error' in r) throw new Error(r.error === 'cancelled' ? '' : r.error);
    if (!verifier) throw new Error('That sign-in has expired. Please try again.');
    const res = await fetcher(`${HANDCASH_ORIGIN}/api/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant: r.grant, code_verifier: verifier, redirect_uri: handcashWebRedirect() }),
    });
    const j = (await res.json().catch(() => ({}))) as { handle?: string; error?: string };
    if (!res.ok || !j.handle) throw new Error(j.error || 'Could not finish signing in with HandCash.');
    const h = String(j.handle).replace(/^\$/, '');
    localStorage.setItem(HANDLE, h);
    lastError = '';
    return h;
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Could not finish signing in with HandCash.';
    return '';
  } finally {
    listeners.forEach((l) => l());
  }
}

/** Called once at start-up: back from HandCash on /auth/handcash?grant=… → take it, clean the address bar. */
export function takeHandCashWebReturn(): void {
  if (typeof location === 'undefined' || location.pathname !== '/auth/handcash') return;
  const here = location.href;
  history.replaceState(null, '', '/');
  void receiveHandCashWeb(here);
}
