import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BchatClient, defaultHttp, type SocialProfile } from '../chat/api';
import { IS_EXTENSION } from '../extension';

/**
 * "Continue with X / Google" on Create Account (owner, 4 Oct 2026). bit-sign proves the X @name or
 * Gmail address; the new wallet then records it and may claim the matching verified paymail
 * (b0asex.x@bwalletx.com, theirname.gmail@bwalletx.com) with its personal token and room.
 *
 * 1. start: a random secret stays here; bit-sign gets only its sha256 and returns the sign-in URL,
 *    opened in the system browser (Google refuses embedded web views).
 * 2. return: bit-sign → www.bwallet.space/social#t=<ticket> → the app (universal link, or the
 *    bwalletx:// scheme from that page; the extension reads the tab). preview() fills name + photo.
 * 3. Choose your handle: the paymail server registers <name>.x / <name>.gmail with the ticket +
 *    secret (it asks the sign-in service what they prove). bWalletX keeps the record; bit-sign
 *    stores nothing (owner, 4 Oct 2026).
 */

export type SocialProvider = 'x' | 'google';
type Pending = { provider: SocialProvider; secret: string; at: number; ticket?: string; profile?: SocialProfile; claimed?: boolean };

const KEY = 'bwallet.social';
const TTL_MS = 10 * 60_000;
const listeners = new Set<() => void>();
let lastError = '';

const read = (): Pending | null => {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as Pending | null;
    return p && Date.now() - p.at < TTL_MS ? p : null;
  } catch {
    return null;
  }
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
/** The verified profile waiting for this new wallet, if any. */
export const socialProfile = () => read()?.profile ?? null;
export const socialError = () => lastError;
export const clearSocial = () => write(null);

const client = () => new BchatClient(defaultHttp(Capacitor.isNativePlatform()));
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function startSocial(provider: SocialProvider): Promise<void> {
  lastError = '';
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const vh = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  const url = await client().socialStart(provider, vh);
  write({ provider, secret, at: Date.now() });
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
  // System browser on phones (Capacitor opens _blank outside the app); a new tab on the web.
  window.open(url, '_blank');
}

const RETURN = 'https://www.bwallet.space/social';
const isReturn = (url: string) => url.startsWith(RETURN) || url.startsWith('bwalletx://social');

/** A return URL (universal link, bwalletx://, or the extension's tab): keep the ticket, fetch the profile. */
export async function receiveSocialUrl(url: string): Promise<void> {
  if (!isReturn(url)) return;
  const q = new URLSearchParams(url.split('#')[1] || '');
  const p = read();
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
    const profile = await client().socialPreview(ticket, p.secret);
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
 * stored with bit-sign.
 */
export function socialProof(): { profile: SocialProfile; ticket: string; secret: string } | null {
  const p = read();
  return p?.ticket && p.profile ? { profile: p.profile, ticket: p.ticket, secret: p.secret } : null;
}

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void receiveSocialUrl(url));
  void CapApp.getLaunchUrl().then((r) => r?.url && void receiveSocialUrl(r.url));
}
