import { MINT_PREVIEWS_ENABLED, STORE_BUILD } from '../storeBuild';
import { SERVICE_ART } from './serviceArtX';

/**
 * Our services as they look on their own sites (owner, 1 Nov 2026: "each service has its own identity"). Each card on
 * the Mint sheet shows its service's logo lockup in that service's colours and type, its share art as the hero, and
 * its accent on the card's button; each tile shows the service's b mark and wordmark.
 *
 *   bMusicX   gold b, "MusicX" in bright blue (bmusicx.com hero), deep-blue waveform
 *   bMoviesX  red b, white condensed caps "BMOVIES" with a red X (Bebas Neue, as bMovies uses)
 *   bVideoX   white "bVideo" with a gold X
 *   bMarketX  multicolour b, "Market" with a multicolour X
 *   the rest  gold b, cream "bName" with a gold X in Space Grotesk (bPicsX, bWriterX, bDriveX, bVaultX, bStoreX,
 *             bJobsX, bModelX)
 *
 * Art: each site's own share image, local webp under 40 KB (art/). bWalletX only: the share images carry each site's
 * own pitch (pay-by-the-second, monthly storage, parody film posters), so a store build draws the brand panel (logo
 * and the service's visuals, no claims) instead, and its bundle has none of the art.
 */
export type ServiceStyle = {
  /** Button and border colour, and the text on it. */
  accent: string;
  onAccent: string;
  /** Dark tint behind its tile and brand panel. */
  tint: string;
  mark: 'gold' | 'red' | 'multi' | 'white';
  /** Its colour for line icons on its tile. */
  ink: string;
  /** A line from its own site, under the lockup on its brand panel (bModelX, which has no share art). */
  tagline?: string;
  /** The wordmark: `head` + `tail` (the X), each in its own colour (a CSS colour or gradient). */
  head: string;
  tail: string;
  headInk: string;
  tailInk: string;
  font: 'grotesk' | 'bebas' | 'heavy';
  /** The site's share art (bWalletX only). */
  art?: string;
  panel: 'music' | 'movies' | 'video' | 'gold' | 'market';
};

const CREAM = '#f4f1e8';
const MULTI = 'linear-gradient(135deg, #e53935 0%, #f5b800 38%, #43a047 66%, #1e88e5 100%)';
const ART = !STORE_BUILD;

const gold = (name: string, art?: string): ServiceStyle => ({
  accent: '#ffd24d',
  onAccent: '#1a1400',
  tint: '#241b06',
  mark: 'gold',
  ink: '#ffd24d',
  head: name.slice(0, -1),
  tail: 'X',
  headInk: CREAM,
  tailInk: '#ffd24d',
  font: 'grotesk',
  art,
  panel: 'gold',
});

export const SERVICE_STYLES: Record<string, ServiceStyle> = {
  bMusicX: {
    accent: '#2f6bff',
    onAccent: '#ffffff',
    tint: '#0a1f4a',
    mark: 'gold',
    ink: '#5b8fff',
    head: 'Music',
    tail: 'X',
    headInk: 'linear-gradient(180deg, #4f86ff, #2457f5)',
    tailInk: 'linear-gradient(180deg, #8bb4ff, #4f86ff)',
    font: 'heavy',
    art: ART ? SERVICE_ART.bMusicX : undefined,
    panel: 'music',
  },
  bMoviesX: {
    accent: '#e50914',
    onAccent: '#ffffff',
    tint: '#3a0306',
    mark: 'red',
    ink: '#ff4d4d',
    head: 'BMOVIES',
    tail: 'X',
    headInk: '#ffffff',
    tailInk: '#e50914',
    font: 'bebas',
    art: ART ? SERVICE_ART.bMoviesX : undefined,
    panel: 'movies',
  },
  bVideoX: {
    accent: '#ffd24d',
    onAccent: '#1a1400',
    tint: '#1c1408',
    mark: 'white',
    ink: '#ffffff',
    head: 'bVideo',
    tail: 'X',
    headInk: '#ffffff',
    tailInk: '#ffd24d',
    font: 'grotesk',
    art: ART ? SERVICE_ART.bVideoX : undefined,
    panel: 'video',
  },
  bPicsX: gold('bPicsX', ART ? SERVICE_ART.bPicsX : undefined),
  bWriterX: gold('bWriterX', ART ? SERVICE_ART.bWriterX : undefined),
  bDriveX: gold('bDriveX', ART ? SERVICE_ART.bDriveX : undefined),
  bJobsX: gold('bJobsX'),
  bModelX: { ...gold('bModelX'), tagline: 'Your 3D models, minted and spun in your wallet.' },
  // Sell or license it and Keep it for good are not open yet: their services' looks are bWalletX only.
  ...(MINT_PREVIEWS_ENABLED
    ? {
        bMarketX: {
          accent: '#ffd24d',
          onAccent: '#1a1400',
          tint: '#12161f',
          mark: 'multi',
          ink: '#ffd24d',
          head: 'Market',
          tail: 'X',
          headInk: CREAM,
          tailInk: MULTI,
          font: 'grotesk',
          panel: 'market',
        },
        bVaultX: gold('bVaultX', ART ? SERVICE_ART.bVaultX : undefined),
        bStoreX: gold('bStoreX', ART ? SERVICE_ART.bStoreX : undefined),
      }
    : {}),
};

export const serviceStyle = (name: string): ServiceStyle | undefined => SERVICE_STYLES[name];
