import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { YoursNative } from '../native';
import { HANDCASH_SIGNIN_ENABLED, socialLoginEnabled } from '../storeBuild';
import {
  HANDCASH_ORIGIN,
  HANDCASH_REDIRECT,
  authorizeUrl,
  challengeFor,
  friendsProblem,
  isHandCashReturn,
  makeVerifier,
  parseReturn,
  type FriendsProblem,
  type HandCashFriend,
} from './handcashCore';

/**
 * Sign in with HandCash (bWalletX only, same store gate as X: storeBuild.ts socialLoginEnabled, guideline 4.8).
 * iOS: ASWebAuthenticationSession on bwalletx://. Android: the system browser, back via appUrlOpen.
 * The verifier lives in memory for one attempt only (never stored). The HandCash token and handle go to the
 * Keychain / Keystore (YoursNative.secure*) and never to localStorage, so this is native-only: the web
 * fallback of secure* is localStorage.
 */

const TOKEN_KEY = 'handcash.token';
const HANDLE_KEY = 'handcash.handle';

let pending: { verifier: string } | null = null;
let lastError = '';
let handle = '';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const handcashAvailable = () => HANDCASH_SIGNIN_ENABLED && socialLoginEnabled() && Capacitor.isNativePlatform();
export const onHandCashChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const handcashError = () => lastError;
/** The signed-in HandCash handle (no $), or '' (call loadHandCash once at start-up). */
export const handcashHandle = () => handle;

export async function loadHandCash(): Promise<string> {
  if (!handcashAvailable()) return '';
  try {
    const [t, h] = await Promise.all([
      YoursNative.secureGet({ key: TOKEN_KEY }),
      YoursNative.secureGet({ key: HANDLE_KEY }),
    ]);
    handle = t.value ? h.value || '' : '';
  } catch {
    handle = '';
  }
  emit();
  return handle;
}

export async function signOutHandCash(): Promise<void> {
  handle = '';
  await YoursNative.secureRemove({ key: TOKEN_KEY }).catch(() => undefined);
  await YoursNative.secureRemove({ key: HANDLE_KEY }).catch(() => undefined);
  emit();
}

export async function startHandCash(): Promise<void> {
  if (!handcashAvailable()) throw new Error('HandCash sign-in is in the bWalletX app.');
  lastError = '';
  const verifier = makeVerifier();
  pending = { verifier };
  const url = authorizeUrl(await challengeFor(verifier));
  if (Capacitor.getPlatform() === 'ios') {
    try {
      const { url: back } = await YoursNative.authSession({ url, scheme: 'bwalletx' });
      await receiveHandCashUrl(back);
    } catch (e) {
      pending = null;
      lastError =
        (e as { code?: string })?.code === 'cancelled' ? '' : e instanceof Error ? e.message : 'Sign-in failed';
      emit();
    }
    return;
  }
  window.open(url, '_blank');
}

/** bit-sign's deep link: exchange the grant with this attempt's verifier, keep the token in secure storage. */
export async function receiveHandCashUrl(url: string): Promise<void> {
  if (!isHandCashReturn(url)) return;
  const p = pending;
  pending = null;
  const r = parseReturn(url);
  if ('error' in r) {
    lastError = r.error === 'cancelled' ? '' : r.error;
    return emit();
  }
  if (!p) {
    lastError = 'That sign-in has expired. Please try again.';
    return emit();
  }
  try {
    const res = await fetch(`${HANDCASH_ORIGIN}/api/auth/native/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant: r.grant, code_verifier: p.verifier, redirect_uri: HANDCASH_REDIRECT }),
    });
    const j = (await res.json().catch(() => ({}))) as { auth_token?: string; handle?: string; error?: string };
    if (!res.ok || !j.auth_token) throw new Error(j.error || 'Could not finish signing in with HandCash.');
    const h = String(j.handle || '').replace(/^\$/, '');
    await YoursNative.secureSet({ key: TOKEN_KEY, value: j.auth_token });
    await YoursNative.secureSet({ key: HANDLE_KEY, value: h });
    handle = h;
    lastError = '';
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Could not finish signing in with HandCash.';
  }
  emit();
}

export class HandCashFriendsError extends Error {
  constructor(readonly problem: FriendsProblem) {
    super(problem);
  }
}

/** GET /api/bitsign/me/handcash-friends with the HandCash token. A 401 forgets the token (sign in again). */
export async function fetchHandCashFriends(): Promise<HandCashFriend[]> {
  const token = handcashAvailable() ? (await YoursNative.secureGet({ key: TOKEN_KEY })).value : null;
  if (!token) throw new HandCashFriendsError('signin');
  let res: Response;
  try {
    res = await fetch(`${HANDCASH_ORIGIN}/api/bitsign/me/handcash-friends`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new HandCashFriendsError('failed');
  }
  if (!res.ok) {
    const problem = friendsProblem(res.status);
    if (problem === 'signin') await signOutHandCash();
    throw new HandCashFriendsError(problem);
  }
  const j = (await res.json().catch(() => ({}))) as { friends?: HandCashFriend[] };
  return Array.isArray(j.friends) ? j.friends : [];
}

if (HANDCASH_SIGNIN_ENABLED && Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void receiveHandCashUrl(url));
  void loadHandCash();
}
