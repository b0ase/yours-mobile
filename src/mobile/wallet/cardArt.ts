import type { CardDesign, PackId, SubFeed } from './cardDesign';
import vexCover from '../media/featured/vexvoid-cover.jpg';
import still1 from '../media/featured/stills/still-1.webp';
import still2 from '../media/featured/stills/still-2.webp';
import still3 from '../media/featured/stills/still-3.webp';
import still4 from '../media/featured/stills/still-4.webp';
import still5 from '../media/featured/stills/still-5.webp';
import still6 from '../media/featured/stills/still-6.webp';
import met436535 from './art/pd/met-436535.webp';
import met436528 from './art/pd/met-436528.webp';
import met45434 from './art/pd/met-45434.webp';
import met437881 from './art/pd/met-437881.webp';
import met437394 from './art/pd/met-437394.webp';
import met437854 from './art/pd/met-437854.webp';
import met437654 from './art/pd/met-437654.webp';
import met435809 from './art/pd/met-435809.webp';
import met435868 from './art/pd/met-435868.webp';
import met438817 from './art/pd/met-438817.webp';
import met437998 from './art/pd/met-437998.webp';
import met436105 from './art/pd/met-436105.webp';
import npg1 from './art/npg/npg-1.webp';
import npg2 from './art/npg/npg-2.webp';
import npg3 from './art/npg/npg-3.webp';
import npg4 from './art/npg/npg-4.webp';
import npg5 from './art/npg/npg-5.webp';
import npg6 from './art/npg/npg-6.webp';
import npgx1 from './art/npgx/npgx-1.webp';
import npgx2 from './art/npgx/npgx-2.webp';
import npgx3 from './art/npgx/npgx-3.webp';
import npgx4 from './art/npgx/npgx-4.webp';
import npgx5 from './art/npgx/npgx-5.webp';

/**
 * Card art catalogue (Design your card › Art, Collections, Subscribe). bWalletX only: loaded lazily and never in a
 * store build (cardArtLoader.ts), so none of these pictures ship in bWallet. Bundled, never hotlinked.
 *
 * Art: public-domain works from The Met's Open Access programme (CC0). Each was checked against the Met collection
 * API (`isPublicDomain: true`, the `licence` URL below) on 14 Oct 2026 and the official image downloaded, cropped to
 * the card and re-encoded as WebP. The Art Institute of Chicago's image server refused downloads that day, so the
 * Monet works the owner suggested (AIC) are not in yet; the Met's own Monets are not public domain.
 */
export type ArtCredit = {
  id: string;
  title: string;
  artist: string;
  year: string;
  museum: string;
  licence: string;
  /** The museum page for the work. */
  source: string;
  /** Where the licence was verified. */
  licenceProof: string;
  src: string;
};

const met = (id: string, title: string, artist: string, year: string, src: string): ArtCredit => ({
  id: 'met-' + id,
  title,
  artist,
  year,
  museum: 'The Met',
  licence: 'CC0',
  source: `https://www.metmuseum.org/art/collection/search/${id}`,
  licenceProof: `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
  src,
});

export const PD_ART: readonly ArtCredit[] = [
  met('436535', 'Wheat Field with Cypresses', 'Vincent van Gogh', '1889', met436535),
  met('45434', 'The Great Wave', 'Katsushika Hokusai', 'ca. 1830–32', met45434),
  met('436528', 'Irises', 'Vincent van Gogh', '1890', met436528),
  met('437881', 'Young Woman with a Water Pitcher', 'Johannes Vermeer', 'ca. 1662', met437881),
  met('437394', 'Aristotle with a Bust of Homer', 'Rembrandt', '1653', met437394),
  met('437854', 'Whalers', 'J. M. W. Turner', 'ca. 1845', met437854),
  met('437654', 'Circus Sideshow', 'Georges Seurat', '1887–88', met437654),
  met('435809', 'The Harvesters', 'Pieter Bruegel the Elder', '1565', met435809),
  met('435868', 'The Card Players', 'Paul Cézanne', '1890–92', met435868),
  met('438817', 'The Dance Class', 'Edgar Degas', '1874', met438817),
  met('437998', 'Olive Trees', 'Vincent van Gogh', '1889', met437998),
  met('436105', 'The Death of Socrates', 'Jacques Louis David', '1787', met436105),
];

export const artCreditLine = (a: ArtCredit) => `${a.artist} · ${a.title} · ${a.museum} (${a.licence})`;

/** Holder packs: our own art. Where to get the thing that unlocks each. */
export type Pack = {
  id: PackId;
  name: string;
  unlock: string;
  /** In-app route to get it. */
  getAt: string;
  items: readonly { id: string; title: string; src: string }[];
};

export const PACKS: readonly Pack[] = [
  {
    id: 'vexvoid',
    name: 'VexVoid',
    unlock: 'Own Echoes in the Abyss to unlock',
    getAt: '/m/media/album/first-12',
    items: [
      { id: 'cover', title: 'Echoes in the Abyss', src: vexCover },
      { id: 'still-1', title: 'Echoes in the Abyss · still 1', src: still1 },
      { id: 'still-2', title: 'Echoes in the Abyss · still 2', src: still2 },
      { id: 'still-3', title: 'Echoes in the Abyss · still 3', src: still3 },
      { id: 'still-4', title: 'Echoes in the Abyss · still 4', src: still4 },
      { id: 'still-5', title: 'Echoes in the Abyss · still 5', src: still5 },
      { id: 'still-6', title: 'Echoes in the Abyss · still 6', src: still6 },
    ],
  },
  {
    id: 'npg',
    name: 'Ninja Punk Girls',
    unlock: 'Own $NPG to unlock',
    getAt: '/m/exchange',
    items: [
      { id: 'asuka', title: 'Asuka', src: npg1 },
      { id: 'hikaru', title: 'Hikaru', src: npg2 },
      { id: 'ichika', title: 'Ichika', src: npg3 },
      { id: 'miyuki', title: 'Miyuki', src: npg4 },
      { id: 'scarlet', title: 'Scarlet', src: npg5 },
      { id: 'yamarashii', title: 'Yamarashii', src: npg6 },
    ],
  },
  {
    id: 'npgx',
    name: 'NPGX',
    unlock: 'Own $NPGX to unlock',
    getAt: '/m/exchange',
    items: [
      { id: 'echo-1', title: 'Echo Neonflare · decks', src: npgx1 },
      { id: 'echo-2', title: 'Echo Neonflare · sparks', src: npgx2 },
      { id: 'echo-3', title: 'Echo Neonflare · rain', src: npgx3 },
      { id: 'echo-4', title: 'Echo Neonflare · lasers', src: npgx4 },
      { id: 'echo-5', title: 'Echo Neonflare · studio', src: npgx5 },
    ],
  },
];

/** MOCK card-art subscriptions: weekly picks per feed (examples; bArt/bPics use the public-domain art as stand-ins). */
export type SubPick = { title: string; artist: string; src: string };
export const SUB_FEEDS: readonly { id: SubFeed; name: string; picks: readonly SubPick[] }[] = [
  {
    id: 'bmusic',
    name: 'bMusic',
    picks: [
      { title: 'Echoes in the Abyss', artist: 'VexVoid', src: vexCover },
      { title: 'Echoes in the Abyss (still)', artist: 'VexVoid', src: still2 },
      { title: 'Echoes in the Abyss (still)', artist: 'VexVoid', src: still4 },
      { title: 'Echoes in the Abyss (still)', artist: 'VexVoid', src: still6 },
    ],
  },
  {
    id: 'bart',
    name: 'bArt',
    picks: PD_ART.slice(0, 4).map((a) => ({ title: a.title, artist: a.artist, src: a.src })),
  },
  {
    id: 'bpics',
    name: 'bPics',
    picks: PD_ART.slice(6, 10).map((a) => ({ title: a.title, artist: a.artist, src: a.src })),
  },
];

export const subPick = (feed: SubFeed, week: number): SubPick => {
  const f = SUB_FEEDS.find((x) => x.id === feed) ?? SUB_FEEDS[0];
  return f.picks[((week % f.picks.length) + f.picks.length) % f.picks.length] as SubPick;
};

/** The picture and credit for a stored design (patterns are drawn elsewhere: cardPatterns.ts). */
export function resolveArt(d: CardDesign | null): { src: string; line: string } | null {
  if (!d) return null;
  if (d.kind === 'art') {
    const a = PD_ART.find((x) => x.id === d.id);
    return a ? { src: a.src, line: artCreditLine(a) } : null;
  }
  if (d.kind === 'pack') {
    const p = PACKS.find((x) => x.id === d.pack);
    const it = p?.items.find((x) => x.id === d.id);
    return p && it ? { src: it.src, line: `Art: ${p.name} · ${it.title}` } : null;
  }
  if (d.kind === 'sub') {
    const pick = subPick(d.feed, d.week);
    const name = SUB_FEEDS.find((x) => x.id === d.feed)?.name ?? d.feed;
    return {
      src: pick.src,
      line: d.active
        ? `This week: ${pick.title} by ${pick.artist} · ${name} subscription · 1p/week · paid so far ${d.paid}p`
        : `${pick.title} by ${pick.artist} · ${name} (subscription stopped)`,
    };
  }
  return null;
}
