import { BASE_LOOK, type Accent } from '../../theme/accents';
import { ensureContrast, luminance, mix, pickReadable } from '../../theme/colour';
import { wearSiteLook } from '../../theme/accent';
import type { Palette } from './library';

/**
 * While a library track plays, the whole wallet wears that album's palette (owner, 26 Oct 2026). It uses the same
 * never-saved overlay as a connected site's look (accent.ts wearSiteLook): the user's own theme is never written,
 * stays the same across tracks of one album, changes when the album changes and comes back on stop or close.
 */
export function albumAccent(p: Palette, label: string): Accent {
  const light = luminance(p.bg) > 0.4;
  const surface2 = mix(p.surface, p.text, 0.06);
  const text = ensureContrast(p.text, [p.bg, p.surface], 4.5);
  return {
    ...BASE_LOOK,
    id: 'custom',
    kind: 'theme',
    label,
    scheme: light ? 'light' : 'dark',
    ...(light ? { paper: true } : {}),
    accent: p.accent,
    hi: mix(p.accent, '#FFFFFF', 0.25),
    lo: mix(p.accent, p.bg, 0.3),
    on: pickReadable(['#FFFFFF', '#0A0A0A'], [p.accent], 4.5),
    bg: p.bg,
    surface: p.surface,
    surface2,
    nav: p.bg,
    text,
    muted: ensureContrast(p.muted, [p.bg, p.surface, surface2], 4.5),
    line: mix(p.surface, p.accent2, 0.35),
  };
}

let worn: string | null = null;

/** The album whose palette is on now, or null. */
export const wornAlbum = (): string | null => worn;

/** Wears an album's palette (same album: nothing changes); null puts the user's own theme back. */
export function wearAlbum(album: { id: string; title: string; theme: Palette } | null): void {
  if (album) {
    if (worn === album.id) return;
    wearSiteLook(albumAccent(album.theme, album.title));
    worn = album.id;
    return;
  }
  if (worn === null) return;
  worn = null;
  wearSiteLook(null);
}

/** Library tracks in the player carry this prefix, so the theme can tell them from every other queue. */
export const LIB_PREFIX = 'lib:';
export const libTrackId = (albumId: string, trackId: string) => `${LIB_PREFIX}${albumId}:${trackId}`;
export const albumOfTrackId = (id: string | undefined): string | null => {
  if (!id || !id.startsWith(LIB_PREFIX)) return null;
  const rest = id.slice(LIB_PREFIX.length);
  const i = rest.indexOf(':');
  return i > 0 ? rest.slice(0, i) : null;
};

/**
 * What the theme should be for this player state: the album of the current library track, or null (stopped, empty,
 * or playing something that is not in the library).
 */
export function albumForPlayer<A extends { id: string }>(
  s: { queue: { id: string }[]; index: number },
  albums: readonly A[],
): A | null {
  const id = albumOfTrackId(s.queue[s.index]?.id);
  return id ? (albums.find((a) => a.id === id) ?? null) : null;
}
