import { MINT_PREVIEWS_ENABLED } from '../storeBuild';

/**
 * One brand system for our services on the Mint sheet (owner-approved mock, 1 Nov 2026): the gold b mark, the name in
 * white, the X in the service's accent, all Inter 800. No per-site logos. The accent colours only the X, the tile's
 * icon, the card's main button, its option chevrons and its hero glow: blue for bMusicX, red for bMoviesX, gold for
 * every other service.
 */
export type ServiceStyle = {
  /** The name after the b mark ("Music" for bMusicX). */
  word: string;
  accent: string;
  /** Text on the accent (the card's main button). */
  onAccent: string;
};

const GOLD: Pick<ServiceStyle, 'accent' | 'onAccent'> = { accent: '#ffd24d', onAccent: '#1a1400' };
const svc = (word: string, look = GOLD): ServiceStyle => ({ word, ...look });

export const SERVICE_STYLES: Record<string, ServiceStyle> = {
  bMusicX: svc('Music', { accent: '#2f6bff', onAccent: '#ffffff' }),
  bMoviesX: svc('Movies', { accent: '#e50914', onAccent: '#ffffff' }),
  bVideoX: svc('Video'),
  bPicsX: svc('Pics'),
  bWriterX: svc('Writer'),
  bModelX: svc('Model'),
  bDriveX: svc('Drive'),
  bJobsX: svc('Jobs'),
  // Sell or license it and Keep it for good are not open yet: bWalletX only.
  ...(MINT_PREVIEWS_ENABLED ? { bVaultX: svc('Vault'), bStoreX: svc('Store'), bMarketX: svc('Market') } : {}),
};

export const serviceStyle = (name: string): ServiceStyle | undefined => SERVICE_STYLES[name];
