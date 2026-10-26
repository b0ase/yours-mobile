import { parseLibrary, type LibraryAlbum } from './library';

/**
 * The last library session (albums + signed URLs), kept in memory and in this device's localStorage until 5 minutes
 * before it expires, so reopening Media shows the shelf at once with no new signature. Only ever written after the
 * server said yes to the owner's key; read back through parseLibrary, so a tampered entry is simply ignored.
 */
export const CACHE_KEY = 'bwx.library.session.v1';
export const CACHE_MARGIN_MS = 5 * 60_000;

export type Session = { albums: LibraryAlbum[]; expiresAt: number };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let mem: Session | null = null;

const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** Usable while now is more than the margin before expiry. */
export const usable = (s: Session | null, now = Date.now()): s is Session => !!s && s.expiresAt - CACHE_MARGIN_MS > now;

export function readCache(now = Date.now(), st: Store | null = store()): Session | null {
  if (usable(mem, now)) return mem;
  mem = null;
  try {
    const raw = st?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = parseLibrary(JSON.parse(raw));
    if (usable(parsed, now)) return (mem = parsed);
    st?.removeItem(CACHE_KEY);
  } catch {
    // unreadable entry: ignore it
  }
  return null;
}

export function writeCache(s: Session, st: Store | null = store()): void {
  mem = s;
  try {
    st?.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    // storage full or blocked: the memory copy still works
  }
}

export function clearCache(st: Store | null = store()): void {
  mem = null;
  try {
    st?.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

const warmed = new Set<string>();
/** Starts downloading every shelf thumbnail (or cover when there is none) so the grid paints from cache. */
export function preloadCovers(albums: LibraryAlbum[], make: () => { src: string } = () => new Image()): number {
  let n = 0;
  for (const a of albums) {
    const src = a.thumb ?? a.cover;
    if (warmed.has(src)) continue;
    warmed.add(src);
    const img = make() as { src: string; decoding?: string };
    img.decoding = 'async';
    img.src = src;
    n++;
  }
  return n;
}

/** A placeholder in the album's own colours while its cover loads (never a grey box). */
export const coverPlaceholder = (t: LibraryAlbum['theme']) =>
  `linear-gradient(135deg, ${t.accent} 0%, ${t.surface} 55%, ${t.bg} 100%)`;
