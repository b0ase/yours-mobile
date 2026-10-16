/**
 * Per-artist opt-in (owner, 16 Oct 2026): an artist whose cover art is black may choose to have it shown inverted
 * in the White theme. Artists choose this themselves; it is never applied globally, because inverting someone's
 * artwork changes it. Only VexVoid has opted in. themes.css applies the filter under [data-bw-paper].
 */
const INVERT_ON_LIGHT: ReadonlySet<string> = new Set(['vexvoid']);

export const invertsOnLight = (artist: string | null | undefined): boolean =>
  !!artist && INVERT_ON_LIGHT.has(artist.trim().toLowerCase());

/** Class to add to an artist's cover image ('' unless the artist opted in). */
export const invertOnLightClass = (artist: string | null | undefined): string =>
  invertsOnLight(artist) ? ' bw-invert-on-light' : '';
