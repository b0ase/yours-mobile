import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { IS_EXTENSION } from '../extension';

/**
 * Sign in with bWalletX (docs/SIGN-IN-WITH-BWALLETX.md): a site sends the user to auth.bwalletx.com/authorize,
 * which hands the request to the wallet three ways:
 *
 *   bwalletx://auth?id=<32 hex>&server=https://auth.bwalletx.com                 (phone app)
 *   https://web.bwalletx.com/m/settings?bwxauth=<id>&server=…                     (web wallet)
 *   https://auth.bwalletx.com/wallet?id=<id>  → caught by background.ts            (Chrome extension)
 *
 * The link carries only a request id. The wallet fetches what is asked from the server it trusts (AUTH_SERVERS,
 * never a server named by a link) and the user approves on one sheet (AuthSheet).
 */
export type AuthLink = { id: string; server: string };

export const DEFAULT_AUTH_SERVER = 'https://auth.bwalletx.com';
const AUTH_SERVERS = new Set([DEFAULT_AUTH_SERVER]);
const DEV_SERVERS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const ID_RE = /^[0-9a-f]{32}$/;

const pickServer = (s: string | null, dev: boolean) => {
  if (!s) return DEFAULT_AUTH_SERVER;
  const clean = s.replace(/\/$/, '');
  if (AUTH_SERVERS.has(clean) || (dev && DEV_SERVERS.has(clean))) return clean;
  return null;
};

/** The request a link carries, or null when it is not a sign-in link or names a server we don't trust. */
export const parseAuthLink = (url: string | null | undefined, dev = !!import.meta.env?.DEV): AuthLink | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    let id: string | null = null;
    if (u.protocol === 'bwalletx:') {
      if (u.host !== 'auth') return null;
      id = u.searchParams.get('id');
    } else if (u.protocol === 'https:' || (dev && u.protocol === 'http:')) {
      if (u.searchParams.has('bwxauth')) id = u.searchParams.get('bwxauth');
      else if (AUTH_SERVERS.has(u.origin) && u.pathname === '/wallet') {
        id = u.searchParams.get('id');
        return id && ID_RE.test(id) ? { id, server: u.origin } : null;
      } else return null;
    } else return null;
    if (!id || !ID_RE.test(id)) return null;
    const server = pickServer(u.searchParams.get('server'), dev);
    return server ? { id, server } : null;
  } catch {
    return null;
  }
};

let pending: AuthLink | null = null;
const listeners = new Set<() => void>();

export const offerAuthLink = (url?: string | null) => {
  const l = parseAuthLink(url);
  if (!l) return false;
  pending = l;
  listeners.forEach((f) => f());
  return true;
};
export const takeAuthLink = () => {
  const l = pending;
  pending = null;
  return l;
};
export const onAuthLink = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerAuthLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerAuthLink(r?.url));
}

/** Extension: background.ts stores the /wallet?id= URL here when that tab opens (like pairing links). */
export const AUTH_LINK_KEY = 'bwalletxPendingAuthLink';
if (IS_EXTENSION && typeof chrome !== 'undefined' && chrome.storage?.local) {
  const pick = (url?: unknown) => {
    if (typeof url !== 'string' || !url) return;
    void chrome.storage.local.remove(AUTH_LINK_KEY);
    offerAuthLink(url);
  };
  chrome.storage.local.get(AUTH_LINK_KEY, (r) => pick(r?.[AUTH_LINK_KEY]));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[AUTH_LINK_KEY]?.newValue) pick(ch[AUTH_LINK_KEY].newValue);
  });
}
