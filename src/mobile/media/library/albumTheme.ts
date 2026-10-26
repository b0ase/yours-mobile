import type { CSSProperties } from 'react';
import { ensureContrast, mix, pickReadable } from '../../theme/colour';
import type { Palette } from './library';

/**
 * An album's colours, for the player only (owner, 26 Oct 2026). They are CSS variables set on the player's own
 * container (album page and Now Playing), never on the document: the wallet always keeps the user's own theme, the
 * mini player stays neutral, and nothing is left behind when the player closes because nothing global was touched.
 */
export type AlbumVars = Record<`--bw-${string}`, string>;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

export function albumVars(p: Palette): AlbumVars {
  const surface2 = mix(p.surface, p.text, 0.06);
  const text = ensureContrast(p.text, [p.bg, p.surface], 4.5);
  const hi = mix(p.accent, '#FFFFFF', 0.25);
  return {
    '--bw-bg': p.bg,
    '--bw-surface': p.surface,
    '--bw-card': p.surface,
    '--bw-card2': surface2,
    '--bw-text': text,
    '--bw-muted': ensureContrast(p.muted, [p.bg, p.surface, surface2], 4.5),
    '--bw-line': mix(p.surface, p.accent2, 0.35),
    '--bw-accent': p.accent,
    '--bw-accent-hi': hi,
    '--bw-accent-hi-rgb': rgb(hi),
    '--bw-accent-lo': mix(p.accent, p.bg, 0.3),
    '--bw-on-accent': pickReadable(['#FFFFFF', '#0A0A0A'], [p.accent], 4.5),
  };
}

/** Style for the player's container: the album's variables plus its background and text colour. */
export const albumStyle = (p: Palette): CSSProperties =>
  ({ ...albumVars(p), background: 'var(--bw-bg)', color: 'var(--bw-text)' }) as CSSProperties;

/** Library tracks in the player carry this prefix, so the player can tell them from every other queue. */
export const LIB_PREFIX = 'lib:';
export const libTrackId = (albumId: string, trackId: string) => `${LIB_PREFIX}${albumId}:${trackId}`;
export const albumOfTrackId = (id: string | undefined): string | null => {
  if (!id || !id.startsWith(LIB_PREFIX)) return null;
  const rest = id.slice(LIB_PREFIX.length);
  const i = rest.indexOf(':');
  return i > 0 ? rest.slice(0, i) : null;
};
/** The track id inside its album ("t1" from "lib:a:t1"), or null for anything not from the library. */
export const trackOfTrackId = (id: string | undefined): string | null =>
  albumOfTrackId(id) ? id!.slice(id!.indexOf(':', LIB_PREFIX.length) + 1) : null;

/** The album of the current library track, or null (stopped, empty, or playing something else). */
export function albumForPlayer<A extends { id: string }>(
  s: { queue: { id: string }[]; index: number },
  albums: readonly A[],
): A | null {
  const id = albumOfTrackId(s.queue[s.index]?.id);
  return id ? (albums.find((a) => a.id === id) ?? null) : null;
}
