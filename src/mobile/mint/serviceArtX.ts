import musicArt from './art/bmusicx.webp';
import videoArt from './art/bvideox.webp';
import moviesArt from './art/bmoviesx.webp';
import picsArt from './art/bpicsx.webp';
import writerArt from './art/bwriterx.webp';
import driveArt from './art/bdrivex.webp';
import vaultArt from './art/bvaultx.webp';
import storeArt from './art/bstorex.webp';

/**
 * Our services' share images, the Mint cards' heroes (owner, 1 Nov 2026). bWalletX only: a store build swaps this file
 * for serviceArtX.store.ts (vite.config.mobile.ts), so the store bundle has none of the art files.
 */
export const SERVICE_ART: Record<string, string> = {
  bMusicX: musicArt,
  bVideoX: videoArt,
  bMoviesX: moviesArt,
  bPicsX: picsArt,
  bWriterX: writerArt,
  bDriveX: driveArt,
  bVaultX: vaultArt,
  bStoreX: storeArt,
};
