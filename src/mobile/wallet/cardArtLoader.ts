import { STORE_BUILD } from '../storeBuild';

/** The card art catalogue (cardArt.ts), lazily, and never in a store build (literal check so Rollup drops it). */
export const CARD_ART_ENABLED = !STORE_BUILD;
export type CardArtModule = typeof import('./cardArt');
let pending: Promise<CardArtModule | null> | null = null;
export const loadCardArt = (): Promise<CardArtModule | null> =>
  (pending ??= import.meta.env.VITE_STORE_BUILD === '1' || STORE_BUILD ? Promise.resolve(null) : import('./cardArt'));
