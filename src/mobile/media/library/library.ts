import type { WalletInterface } from '@bsv/sdk';
import { BWALLET_PAYMAIL_API } from '../../names/config';
import { signRequest } from '../../names/paymail';

/**
 * The owner's private music library on /m/media (owner, 26 Oct 2026). Nothing about it ships in the app: no titles,
 * covers, audio or palettes are bundled, published, shared or put on chain. The wallet proves its identity key with a
 * signed request (names/paymail.ts signRequest) and the server answers with the albums and short-lived signed URLs
 * for their covers and audio, only when that key holds the owner's name. The handle check below only decides whether
 * to show the shelf at all: it is cosmetic, the server is the lock. Server spec: PR description ("Library server").
 */
export const LIBRARY_OWNER = 'b0asex@bwalletx.com';
export const LIBRARY_ACTION = 'library-session';
export const LIBRARY_PATH = '/api/library/session';

/** Whether this wallet's handle is the owner's (case-insensitive). Cosmetic gate only. */
export const isLibraryOwner = (handle: string | null | undefined): boolean =>
  typeof handle === 'string' && handle.trim().toLowerCase() === LIBRARY_OWNER;

/** An album's colours: six #RRGGBB values. */
export type Palette = { bg: string; surface: string; accent: string; accent2: string; text: string; muted: string };
export type LibraryTrack = { id: string; title: string; url: string; duration?: number };
export type LibraryAlbum = {
  id: string;
  title: string;
  artist?: string;
  cover: string;
  theme: Palette;
  tracks: LibraryTrack[];
};
export type Unavailable = 'not_configured' | 'denied' | 'network' | 'invalid';
export type LibraryState =
  | { status: 'loading' }
  | { status: 'ok'; albums: LibraryAlbum[]; expiresAt: number }
  | { status: 'unavailable'; reason: Unavailable };

const PALETTE_KEYS = ['bg', 'surface', 'accent', 'accent2', 'text', 'muted'] as const;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ALBUMS = 50;
const MAX_TRACKS = 200;

const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[<>]/.test(v);

/** Only https links (the signed storage URLs); nothing else is ever put in an <img> or <audio>. */
export const safeUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

const parsePalette = (v: unknown): Palette | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const out = {} as Palette;
  for (const k of PALETTE_KEYS) {
    if (typeof p[k] !== 'string' || !HEX.test(p[k] as string)) return null;
    out[k] = (p[k] as string).toUpperCase();
  }
  return out;
};

const parseTrack = (v: unknown): LibraryTrack | null => {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (typeof t.id !== 'string' || !ID.test(t.id) || !text(t.title, 120) || !safeUrl(t.url)) return null;
  const d = typeof t.duration === 'number' && t.duration > 0 && t.duration < 86400 ? t.duration : undefined;
  return { id: t.id, title: t.title, url: t.url, ...(d ? { duration: d } : {}) };
};

const parseAlbum = (v: unknown): LibraryAlbum | null => {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || !ID.test(a.id) || !text(a.title, 80) || !safeUrl(a.cover)) return null;
  if (a.artist !== undefined && !text(a.artist, 80)) return null;
  const theme = parsePalette(a.theme);
  if (!theme || !Array.isArray(a.tracks)) return null;
  const tracks = a.tracks.slice(0, MAX_TRACKS).map(parseTrack);
  if (tracks.some((t) => !t)) return null;
  return {
    id: a.id,
    title: a.title,
    ...(typeof a.artist === 'string' ? { artist: a.artist } : {}),
    cover: a.cover,
    theme,
    tracks: tracks as LibraryTrack[],
  };
};

/** The server's answer, checked field by field; null if anything is off. */
export function parseLibrary(v: unknown): { albums: LibraryAlbum[]; expiresAt: number } | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.albums) || typeof r.expiresAt !== 'number' || !isFinite(r.expiresAt)) return null;
  const albums = r.albums.slice(0, MAX_ALBUMS).map(parseAlbum);
  if (albums.some((a) => !a)) return null;
  return { albums: albums as LibraryAlbum[], expiresAt: r.expiresAt };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/**
 * Asks the server for a library session: a signed request from the identity key, answered with the albums and signed
 * URLs. Every failure (no server configured, not the owner, offline, a bad answer) is a clean "unavailable".
 */
export async function fetchLibrary(
  f: Fetch,
  wallet: Signer,
  base: string = BWALLET_PAYMAIL_API,
): Promise<LibraryState> {
  if (!base) return { status: 'unavailable', reason: 'not_configured' };
  let r: Response;
  try {
    const signed = await signRequest(wallet, LIBRARY_ACTION, {});
    r = await f(`${base}${LIBRARY_PATH}`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    });
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
  if (r.status === 401 || r.status === 403) return { status: 'unavailable', reason: 'denied' };
  if (r.status === 404 || r.status === 501 || r.status === 503)
    return { status: 'unavailable', reason: 'not_configured' };
  if (!r.ok) return { status: 'unavailable', reason: 'network' };
  const parsed = parseLibrary(await r.json().catch(() => null));
  return parsed ? { status: 'ok', ...parsed } : { status: 'unavailable', reason: 'invalid' };
}

export const UNAVAILABLE_TEXT: Record<Unavailable, string> = {
  not_configured: 'The library server is not set up yet.',
  denied: 'This wallet is not allowed to open the library.',
  network: 'Could not reach the library. Check your connection.',
  invalid: 'The library sent something unexpected.',
};
