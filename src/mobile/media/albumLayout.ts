/**
 * Where the album's track list goes on the Media home, so it shows once with one sponsor line:
 * Hybrid with the album as hero = the compact list inside the hero ("See all" expands it in place);
 * otherwise (List, or another hero slide) = the full Tracks list below. Cards = neither (the Albums shelf).
 */
export const albumBlocks = (s: {
  view: 'cards' | 'list' | 'hybrid';
  heroIsAlbum: boolean;
  /** The single-album case (one album in the store). */
  oneAlbum: boolean;
}): { inHero: boolean; fullList: boolean } => {
  const inHero = s.view === 'hybrid' && s.heroIsAlbum;
  return { inHero, fullList: s.view !== 'cards' && s.oneAlbum && !inHero };
};
