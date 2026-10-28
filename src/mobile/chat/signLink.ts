/**
 * "Sign on your phone" QR (bChatX document card, bit-sign src/lib/phone-sign-link.ts) opening THIS app.
 *
 * The QR is a reference, never a key: room ticker + document id + the document's full sha256. Accepted forms:
 *   https://www.bchatx.com/r/<TICKER>?sign=<docId>&h=<sha256>     universal link / app link (bchatx.com AASA: /r/*)
 *   https://www.bchatx.com/room/<TICKER>?sign=<docId>&h=<sha256>  today's QR; opens the app only once /room/* is
 *                                                                 in bchatx.com's AASA (else it stays in Safari)
 *   bwalletx://sign/<TICKER>?sign=<docId>&h=<sha256>             app-scheme fallback
 * (also on chat.bwalletx.com and the bare bchatx.com.)
 *
 * The app opens the room with its "Document waiting for signature" banner on that document and opens the bChatX
 * signing page in the wallet's own browser (already connected, so signed in). That page fetches the bytes,
 * recomputes the hash and refuses on any mismatch before it offers to sign; nothing here signs anything.
 *
 * PURE apart from the listener at the bottom (signLink.test.ts imports the parser).
 */
import { BCHAT_HOSTS, BCHAT_PRIMARY_ORIGIN } from '../../services/bchatOrigin';

const TICKER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HOSTS: ReadonlySet<string> = new Set(BCHAT_HOSTS);

export type SignLink = { ticker: string; docId: string; hash: string };

/** The document a sign QR names, or null for anything else (other hosts, paths, schemes, malformed params). */
export const parseSignLink = (link: string | null | undefined): SignLink | null => {
  if (!link) return null;
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  let raw = '';
  if (u.protocol === 'https:' && HOSTS.has(u.host) && !u.username && !u.password) {
    const m = /^\/(?:r|room)\/([^/]+)\/?$/.exec(u.pathname);
    if (!m) return null;
    raw = m[1];
  } else if (u.protocol === 'bwalletx:') {
    // bwalletx://sign/<T>: host "sign", path "/<T>" (some WebViews give an empty host and path "//sign/<T>").
    const path = u.host === 'sign' ? u.pathname : u.pathname.replace(/^\/+sign(?=\/)/, '');
    if (u.host !== 'sign' && path === u.pathname) return null;
    const m = /^\/([^/]+)\/?$/.exec(path);
    if (!m) return null;
    raw = m[1];
  } else return null;
  let ticker: string;
  try {
    ticker = decodeURIComponent(raw).replace(/^\$/, '');
  } catch {
    return null;
  }
  const docId = u.searchParams.get('sign') || '';
  const hash = (u.searchParams.get('h') || '').toLowerCase();
  if (!TICKER_RE.test(ticker) || !ID_RE.test(docId) || !HASH_RE.test(hash)) return null;
  return { ticker: ticker.toUpperCase(), docId, hash };
};

export const isSignLink = (link: string | null | undefined) => parseSignLink(link) !== null;

/**
 * bChatX's phone-sign page for one document (bit-sign buildPhoneSignUrl): /room/<T>?sign=<id>&h=<hash>. Always
 * rebuilt from checked parts; liveBchatUrl (dappBrowser) moves it to the live origin.
 */
export const phoneSignUrl = (s: SignLink): string => {
  const u = new URL(`/room/${encodeURIComponent(s.ticker)}`, BCHAT_PRIMARY_ORIGIN);
  u.searchParams.set('sign', s.docId);
  u.searchParams.set('h', s.hash);
  return u.toString();
};

// The hash each scanned document came with, so the room's banner can open the hash-checked page (tickers upper-case).
const hashes = new Map<string, string>();
const docKey = (ticker: string, docId: string) => `${ticker.replace(/^\$/, '').toUpperCase()}\n${docId}`;
export const docHashFor = (ticker: string, docId: string): string | null => hashes.get(docKey(ticker, docId)) ?? null;

let pending: SignLink | null = null;
const listeners = new Set<() => void>();

/** Accepts a sign link (true) and holds it until a screen with the router takes it. */
export const offerSignLink = (link?: string | null): boolean => {
  const s = parseSignLink(link);
  if (!s) return false;
  hashes.set(docKey(s.ticker, s.docId), s.hash);
  pending = s;
  listeners.forEach((l) => l());
  return true;
};
export const takeSignLink = (): SignLink | null => {
  const s = pending;
  pending = null;
  return s;
};
export const onSignLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
