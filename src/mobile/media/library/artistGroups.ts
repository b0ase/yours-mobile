import type { LibraryAlbum } from './library';

/** URL slug for an artist name ("VexVoid" -> "vexvoid"), matching the Artists page's own slugs. */
export const artistSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'artist';

export type LibraryArtist = { slug: string; name: string; albums: LibraryAlbum[] };

/** The library's albums grouped by artist (manifest order kept); albums with no artist go under "Various Artists". */
export function groupByArtist(albums: readonly LibraryAlbum[]): LibraryArtist[] {
  const out = new Map<string, LibraryArtist>();
  for (const a of albums) {
    const name = a.artist?.trim() || 'Various Artists';
    const slug = artistSlug(name);
    const g = out.get(slug) ?? { slug, name, albums: [] };
    g.albums.push(a);
    out.set(slug, g);
  }
  return [...out.values()];
}
