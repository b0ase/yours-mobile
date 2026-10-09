/**
 * bPhone client (docs/BPHONE-PLAN.md): the rate card + listing lives on the bWallet paymail
 * server (site/lib/paymail.js bphone-*), keyed by identity key, so it follows the wallet across
 * devices and anyone can read it before dialling. Writes are signed by the identity key, the same
 * way the paymail claim is. Bookings (scheduled calls) live there too.
 *
 * Nothing here moves money: the pay loop is in store.ts.
 */
import type { WalletInterface } from '@bsv/sdk';
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { paymailEnabled, signRequest } from '../names/paymail';
import { EMPTY_PROFILE, parseBooking, parseProfile, type Booking, type BPhoneProfile, type Category } from './rateCard';

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

const api = (path: string) => `${BWALLET_PAYMAIL_API}/api/paymail/${path}`;

const postJson = async (f: Fetch, url: string, body: unknown) => {
  const r = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `HTTP ${r.status}`);
  return j;
};

/** A callee's public bPhone record: their profile plus the paymail BSV payments go to. */
export interface PeerBPhone {
  key: string;
  profile: BPhoneProfile;
  paymail: string | null;
  name: string | null;
  avatar: string | null;
  /** Checks the server vouches for (optional; older servers send none). */
  verified?: Verified;
}

/** Badges a listing may carry: X / Google sign-in linked, and KYC Verified. */
export interface Verified {
  x: boolean;
  google: boolean;
  kyc: boolean;
}
export const parseVerified = (raw: unknown): Verified | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const v = { x: r.x === true, google: r.google === true, kyc: r.kyc === true };
  return v.x || v.google || v.kyc ? v : undefined;
};

export const bphoneEnabled = () => paymailEnabled();

// ── my profile (per identity, cached locally so the screen paints at once and works offline) ──

const myKey = (identityKey: string) => `bwallet.bphone.me.${identityKey}`;

export const readMyProfileCache = (identityKey: string): BPhoneProfile | null => {
  try {
    const raw = localStorage.getItem(myKey(identityKey));
    return raw ? parseProfile(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
};

const writeMyProfileCache = (identityKey: string, p: BPhoneProfile) => {
  try {
    localStorage.setItem(myKey(identityKey), JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
};

/** What the callee side of a call needs without a network trip: my own rate card. */
export const myRateCard = (identityKey: string) => readMyProfileCache(identityKey)?.rate ?? null;

/** Fetch my profile from the server (falls back to the cache; EMPTY_PROFILE when neither has one). */
export const loadMyProfile = async (f: Fetch, identityKey: string): Promise<BPhoneProfile> => {
  const cached = readMyProfileCache(identityKey);
  if (!bphoneEnabled()) return cached ?? EMPTY_PROFILE;
  try {
    const peer = await fetchPeerBPhone(f, identityKey, true);
    if (peer) {
      writeMyProfileCache(identityKey, peer.profile);
      return peer.profile;
    }
    return cached ?? EMPTY_PROFILE;
  } catch {
    return cached ?? EMPTY_PROFILE;
  }
};

export const saveMyProfile = async (f: Fetch, wallet: Signer, profile: BPhoneProfile): Promise<BPhoneProfile> => {
  if (!bphoneEnabled()) throw new Error('bPhone needs a bWallet paymail');
  const identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
  const body = { v: 1, rate: profile.rate, listing: profile.listing, ...(profile.mail ? { mail: profile.mail } : {}) };
  const j = await postJson(
    f,
    api('bphone-put'),
    await signRequest(wallet, 'bphone-put', { profile: JSON.stringify(body) }),
  );
  const saved = parseProfile(j.profile);
  writeMyProfileCache(identityKey, saved);
  peerCache.delete(identityKey);
  return saved;
};

// ── other people ──

const peerCache = new Map<string, { at: number; v: PeerBPhone | null }>();
const PEER_TTL_MS = 60_000;

/** A peer's rate card and listing, or null when they have none (= free calls). Cached a minute. */
export const fetchPeerBPhone = async (f: Fetch, identityKey: string, fresh = false): Promise<PeerBPhone | null> => {
  if (!bphoneEnabled()) return null;
  const key = identityKey.toLowerCase();
  const hit = peerCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < PEER_TTL_MS) return hit.v;
  const r = await f(`${api('bphone-get')}?key=${encodeURIComponent(key)}`);
  if (r.status === 404) {
    peerCache.set(key, { at: Date.now(), v: null });
    return null;
  }
  if (!r.ok) throw new Error(`Could not read their bPhone (${r.status})`);
  const j = (await r.json()) as {
    key: string;
    profile: unknown;
    paymail?: string | null;
    name?: string | null;
    avatar?: string | null;
  };
  const v: PeerBPhone = {
    key,
    profile: parseProfile(j.profile),
    paymail: typeof j.paymail === 'string' ? j.paymail : null,
    name: typeof j.name === 'string' ? j.name : null,
    avatar: typeof j.avatar === 'string' ? j.avatar : null,
  };
  peerCache.set(key, { at: Date.now(), v });
  return v;
};

/** Everyone listed in the bPhone directory, newest first. */
export const fetchDirectory = async (f: Fetch, category?: Category | null): Promise<PeerBPhone[]> => {
  if (!bphoneEnabled()) return [];
  const r = await f(`${api('bphone-directory')}${category ? `?category=${encodeURIComponent(category)}` : ''}`);
  if (!r.ok) throw new Error(`Directory unavailable (${r.status})`);
  const j = (await r.json()) as { listings?: unknown[] };
  const out: PeerBPhone[] = [];
  for (const raw of j.listings ?? []) {
    const l = raw as {
      key?: unknown;
      profile?: unknown;
      paymail?: unknown;
      name?: unknown;
      avatar?: unknown;
      verified?: unknown;
    };
    if (typeof l.key !== 'string') continue;
    out.push({
      key: l.key,
      profile: parseProfile(l.profile),
      paymail: typeof l.paymail === 'string' ? l.paymail : null,
      name: typeof l.name === 'string' ? l.name : null,
      avatar: typeof l.avatar === 'string' ? l.avatar : null,
      verified: parseVerified(l.verified),
    });
  }
  return out;
};

// ── bookings ──

export const requestBooking = async (
  f: Fetch,
  wallet: Signer,
  req: { calleeKey: string; at: Date; minutes: number; note?: string; callerLabel?: string },
): Promise<Booking> => {
  const j = await postJson(
    f,
    api('bphone-book'),
    await signRequest(wallet, 'bphone-book', {
      calleeKey: req.calleeKey.toLowerCase(),
      at: req.at.toISOString(),
      minutes: String(req.minutes),
      note: (req.note ?? '').slice(0, 280),
      callerLabel: (req.callerLabel ?? '').slice(0, 80),
    }),
  );
  const b = parseBooking(j.booking);
  if (!b) throw new Error('Booking failed');
  return b;
};

export const listBookings = async (f: Fetch, wallet: Signer): Promise<Booking[]> => {
  if (!bphoneEnabled()) return [];
  const j = await postJson(f, api('bphone-bookings'), await signRequest(wallet, 'bphone-bookings', {}));
  return (Array.isArray(j.bookings) ? j.bookings : []).map(parseBooking).filter((b): b is Booking => b !== null);
};

export const actBooking = async (
  f: Fetch,
  wallet: Signer,
  id: string,
  action: 'confirm' | 'decline' | 'cancel',
): Promise<Booking> => {
  const j = await postJson(f, api('bphone-book-act'), await signRequest(wallet, 'bphone-book-act', { id, action }));
  const b = parseBooking(j.booking);
  if (!b) throw new Error('Booking update failed');
  return b;
};
