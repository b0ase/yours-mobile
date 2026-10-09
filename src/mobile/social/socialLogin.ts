import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { SocialProfile } from '../chat/api';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { IS_EXTENSION } from '../extension';
import { YoursNative } from '../native';

/**
 * "Continue with X / Google" on Create Account (owner, 4 Oct 2026). bWalletX's own sign-in service
 * (paymail server, site/lib/social.js) proves the X @name or Gmail address; the new wallet then records it and may claim the matching verified paymail
 * (b0asex.x@bwalletx.com, theirname.gmail@bwalletx.com) with its personal token and room.
 *
 * 1. start: a random secret stays here; the sign-in service gets only its sha256 and returns the
 *    provider's sign-in URL, opened in the system browser (Google refuses embedded web views).
 * 2. return: pay server → www.bwallet.space/social#t=<ticket> → the app (universal link, or the
 *    bwalletx:// scheme from that page; the extension reads the tab). preview() fills name + photo.
 * 3. Choose your handle: the paymail server registers <name>.x / <name>.gmail with the ticket +
 *    secret. bWalletX keeps the record; bit-sign plays no part.
 */

export type SocialProvider = 'x' | 'google';
type Pending = {
  provider: SocialProvider;
  secret: string;
  at: number;
  ticket?: string;
  profile?: SocialProfile;
  claimed?: boolean;
  /**
   * Whose sign-in this is: NEW_ACCOUNT while Create / Restore / Import is open, else the identity address of
   * the account that started it (Settings › Connect X / Google), and after account creation the new account's.
   * A pending sign-in is only ever shown to its owner, so one account's X / Google photo and name can't
   * pre-fill another account (owner, 8 Oct 2026: Testy's Create Account showed an earlier login's photo).
   */
  owner?: string;
};

/** Owner of a sign-in started on Create / Restore / Import, before the account (and its identity) exists. */
export const NEW_ACCOUNT = 'new';

const KEY = 'bwallet.social';
const TTL_MS = 10 * 60_000;
const listeners = new Set<() => void>();
let lastError = '';

const readAny = (): Pending | null => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as Pending | null;
    if (!p) return null;
    // Expired, or a leftover from before sign-ins had an owner (global): drop it.
    if (!p.owner || !(Date.now() - p.at < TTL_MS)) {
      localStorage.removeItem(KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
};
/** The pending sign-in, only for its owner. */
const read = (owner: string): Pending | null => {
  const p = readAny();
  return p && owner && p.owner === owner ? p : null;
};
const write = (p: Pending | null) => {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the flow just won't survive a reload */
  }
  listeners.forEach((l) => l());
};

export const onSocialChange = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
/** The verified profile waiting for `owner` (NEW_ACCOUNT on Create / Restore / Import, else an identity address). */
export const socialProfile = (owner: string = NEW_ACCOUNT) => read(owner)?.profile ?? null;
export const socialError = () => lastError;
export const clearSocial = () => write(null);

/**
 * Account just created / restored: a sign-in made on that screen now belongs to the new identity, so the
 * next Create Account (or another account) never sees it.
 */
export const bindSocial = (identityAddress: string) => {
  const p = readAny();
  if (p && identityAddress && p.owner === NEW_ACCOUNT) write({ ...p, owner: identityAddress });
};

// bWalletX's own sign-in service (site/lib/social.js on the paymail server).
const post = async <T>(op: string, body: unknown): Promise<T> => {
  const r = await fetch(`${BWALLET_PAYMAIL_API}/api/social/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Sign-in failed (${r.status})`);
  return j;
};
const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function startSocial(provider: SocialProvider, owner: string = NEW_ACCOUNT): Promise<void> {
  lastError = '';
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const vh = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  // Web wallet: sign in in THIS tab and come back to web.bwalletx.com (owner, 6 Oct 2026: a new tab ended on the
  // phones' "you're signed in" page with no way back to the wallet). The pending secret survives in localStorage.
  const web = !Capacitor.isNativePlatform() && !IS_EXTENSION;
  const { authorizeUrl: url } = await post<{ authorizeUrl: string }>('start', {
    provider,
    verifier_hash: vh,
    ...(web ? { return_to: webReturnKey() } : {}),
  });
  write({ provider, secret, at: Date.now(), owner });
  if (web) {
    window.location.assign(url);
    return;
  }
  if (IS_EXTENSION && typeof chrome !== 'undefined' && chrome.tabs) {
    const tab = await chrome.tabs.create({ url });
    const done = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id !== tab.id || !info.url?.startsWith(RETURN)) return;
      chrome.tabs.onUpdated.removeListener(done);
      void receiveSocialUrl(info.url);
      void chrome.tabs.remove(id).catch(() => undefined);
    };
    chrome.tabs.onUpdated.addListener(done);
    return;
  }
  // iOS: an in-app Safari sign-in session (owner, 6 Oct 2026). Opening x.com with window.open let the
  // X app take it by universal link: its in-app browser turned X's "Sign in with Google" white, and its
  // "Open bWalletX" link did nothing. The session returns the bwalletx:// URL the return page navigates to.
  if (Capacitor.getPlatform() === 'ios') {
    try {
      const { url: back } = await YoursNative.authSession({
        url,
        scheme: 'bwalletx',
        httpsHost: 'www.bwallet.space',
        httpsPath: '/social',
      });
      await receiveSocialUrl(back);
    } catch (e) {
      lastError =
        (e as { code?: string })?.code === 'cancelled' ? '' : e instanceof Error ? e.message : 'Sign-in failed';
      write(null);
    }
    return;
  }
  // Android: the system browser (Capacitor opens _blank outside the app).
  window.open(url, '_blank');
}

const RETURN = 'https://www.bwallet.space/social';
// Web wallet origins the sign-in server returns to (exact list; the server maps the key, never a caller URL).
const WEB_RETURNS = {
  web: 'https://web.bwalletx.com/',
  beta: 'https://beta.bwalletx.com/',
  desktop: 'https://desktop.bwalletx.com/',
} as const;
const webReturnKey = (): keyof typeof WEB_RETURNS => {
  if (typeof location === 'undefined') return 'web';
  const key = (Object.keys(WEB_RETURNS) as (keyof typeof WEB_RETURNS)[]).find((k) => WEB_RETURNS[k] === `${location.origin}/`);
  return key ?? 'web';
};
const isWebReturn = (url: string) => Object.values(WEB_RETURNS).some((r) => url.startsWith(r));
const isReturn = (url: string) =>
  url.startsWith(RETURN) ||
  url.startsWith('bwalletx://social') ||
  (isWebReturn(url) && /#(.*&)?(t|error)=/.test(url));

/** A return URL (universal link, bwalletx://, or the extension's tab): keep the ticket, fetch the profile. */
export async function receiveSocialUrl(url: string): Promise<void> {
  if (!isReturn(url)) return;
  const q = new URLSearchParams(url.split('#')[1] || '');
  const p = readAny();
  if (q.get('error')) {
    lastError = q.get('error') === 'cancelled' ? 'Sign-in cancelled.' : String(q.get('error'));
    return write(p ? { ...p, ticket: undefined } : null);
  }
  const ticket = q.get('t');
  if (!p || !ticket) {
    lastError = 'That sign-in has expired. Please try again.';
    return write(null);
  }
  try {
    const profile = await post<SocialProfile>('preview', { ticket, secret: p.secret });
    lastError = '';
    write({ ...p, ticket, profile });
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Sign-in failed';
    write(null);
  }
}

/**
 * The verified profile and its proof, for registering the verified paymail name. bWalletX keeps
 * that record itself (its paymail server checks the proof with the sign-in service); nothing is
 * stored anywhere else.
 */
export function socialProof(
  owner: string = NEW_ACCOUNT,
): { profile: SocialProfile; ticket: string; secret: string } | null {
  const p = read(owner);
  return p?.ticket && p.profile ? { profile: p.profile, ticket: p.ticket, secret: p.secret } : null;
}

// Web wallet: back from the provider in this tab with #p=…&t=… (or #error=…). Take it, then clear the address
// bar so the ticket isn't left in history or re-read on reload.
if (
  !Capacitor.isNativePlatform() &&
  !IS_EXTENSION &&
  typeof location !== 'undefined' &&
  isWebReturn(location.href)
) {
  const here = location.href;
  if (isReturn(here)) {
    history.replaceState(null, '', location.pathname + location.search);
    void receiveSocialUrl(here);
  }
}

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void receiveSocialUrl(url));
  void CapApp.getLaunchUrl().then((r) => r?.url && void receiveSocialUrl(r.url));
}
