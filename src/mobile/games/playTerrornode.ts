import { openBapp } from '../bappFrame/bappFrame';
import { routeFor } from '../tabs/tabs';
import { TERRORNODE_URL } from './TerrornodeHeroX';

/**
 * Play TERRORNODE full screen in the wallet's own browser (already connected). The bApps page hosts the in-wallet
 * frame (it shows only while that page is on screen), so go there and open the game the way the TERRORNODE hero
 * does (BrowserPage go → openBapp; full-screen browser if it can't frame). Shared by the b menu (tabs/TopNav.tsx)
 * and the game room's live player (chat/GameRoomPlayer.tsx).
 */
export const playTerrornode = (navigate: (to: string) => void) => {
  navigate(routeFor('browser') ?? '/browser');
  void openBapp('TERRORNODE', TERRORNODE_URL);
};
