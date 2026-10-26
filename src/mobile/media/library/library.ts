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
  /** Optional small cover (about 400 px) the shelf prefers; the album page and Now Playing use the full cover. */
  thumb?: string;
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

/**
 * A readable song title from a file-name style one: drops the extension, a leading track number ("01 -", "3."),
 * dashes and underscores, then title-cases words written all in one case. Real titles pass through unchanged.
 */
export const cleanTitle = (raw: string): string => {
  let t = raw.trim().replace(/\.(mp3|m4a|aac|wav|flac|ogg)$/i, '');
  const fileLike = /[_]|^\d{1,3}\s*[-._)]|\s-\s|^[a-z0-9-]+$/.test(t);
  if (!fileLike) return t;
  t = t
    .replace(/^\d{1,3}\s*[-._)]+\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/(^|\s)-+|-+(\s|$)/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return raw.trim();
  const oneCase = t === t.toLowerCase() || t === t.toUpperCase();
  return oneCase ? t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, s, c: string) => s + c.toUpperCase()) : t;
};

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
  return { id: t.id, title: cleanTitle(t.title), url: t.url, ...(d ? { duration: d } : {}) };
};

const parseAlbum = (v: unknown): LibraryAlbum | null => {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || !ID.test(a.id) || !text(a.title, 80) || !safeUrl(a.cover)) return null;
  if (a.artist !== undefined && !text(a.artist, 80)) return null;
  const theme = parsePalette(a.theme);
  if (!theme || !Array.isArray(a.tracks)) return null;
  // A bad track is dropped; the rest of the album still plays.
  const tracks = a.tracks.slice(0, MAX_TRACKS).map(parseTrack).filter(Boolean);
  return {
    id: a.id,
    title: a.title,
    ...(typeof a.artist === 'string' ? { artist: a.artist } : {}),
    cover: a.cover,
    ...(safeUrl(a.thumb) ? { thumb: a.thumb } : {}),
    theme,
    tracks: tracks as LibraryTrack[],
  };
};

/** The server's answer, checked field by field; null if anything is off. */
export function parseLibrary(v: unknown): { albums: LibraryAlbum[]; expiresAt: number } | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.albums) || typeof r.expiresAt !== 'number' || !isFinite(r.expiresAt)) return null;
  // One malformed album is dropped, never the whole shelf. Only an answer with nothing usable is refused.
  const all = r.albums.slice(0, MAX_ALBUMS);
  const albums = all.map(parseAlbum).filter((a): a is LibraryAlbum => !!a);
  if (all.length && !albums.length) return null;
  return { albums, expiresAt: r.expiresAt };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/**
 * Asks the server for a library session: a signed request from the identity key, answered with the albums and signed
 * URLs. Every failure (no server configured, not the owner, offline, a bad answer) is a clean "unavailable".
 */
export const LIBRARY_TIMEOUT_MS = 15_000;

/** Rejects after ms, so a request that never answers ends as "network" instead of loading for ever. */
const within = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), ok(v)),
      (e) => (clearTimeout(t), no(e)),
    );
  });

export async function fetchLibrary(
  f: Fetch,
  wallet: Signer,
  base: string = BWALLET_PAYMAIL_API,
  timeoutMs: number = LIBRARY_TIMEOUT_MS,
): Promise<LibraryState> {
  if (!base) return { status: 'unavailable', reason: 'not_configured' };
  let r: Response;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const signed = await within(signRequest(wallet, LIBRARY_ACTION, {}), timeoutMs);
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    r = await within(
      f(`${base}${LIBRARY_PATH}`, {
        method: 'POST',
        signal: ctl?.signal,
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
      }),
      timeoutMs,
    ).finally(() => clearTimeout(timer));
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
  if (r.status === 401 || r.status === 403) return { status: 'unavailable', reason: 'denied' };
  if (r.status === 404 || r.status === 501 || r.status === 503)
    return { status: 'unavailable', reason: 'not_configured' };
  if (!r.ok) return { status: 'unavailable', reason: 'network' };
  const parsed = parseLibrary(await within(r.json(), timeoutMs).catch(() => null));
  return parsed ? { status: 'ok', ...parsed } : { status: 'unavailable', reason: 'invalid' };
}

export const UNAVAILABLE_TEXT: Record<Unavailable, string> = {
  not_configured: 'The library server is not set up yet.',
  denied: 'This wallet is not allowed to open the library.',
  network: 'Could not reach the library. Check your connection.',
  invalid: 'The library sent something unexpected.',
};

/** Cover candidates in order: the small thumbnail for the shelf when the server sent one, then the full cover. */
export const coverSources = (a: Pick<LibraryAlbum, 'cover' | 'thumb'>, small?: boolean): string[] =>
  small && a.thumb ? [a.thumb, a.cover] : [a.cover];
