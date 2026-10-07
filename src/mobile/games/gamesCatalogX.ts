/**
 * bWalletX-only: the TokenBlaster.lol arcade (every game spends real tokens in LIVE mode, some charge per
 * play). A store build swaps this file for gamesCatalogX.store.ts (vite.config.mobile.ts), so none of it is
 * in that bundle. Read from tokenblaster.lol/arcade on 7 Oct 2026.
 */
import type { Game } from './gamesCatalog';

const TB = 'https://www.tokenblaster.lol';
const tb = (path: string, name: string, desc: string, img: string): Game => ({
  name,
  url: `${TB}${path}`,
  desc,
  img: `${TB}/arcade/${img}.jpg`,
  source: 'tokenblaster',
});

export const TOKENBLASTER_GAMES: Game[] = [
  tb('/arcade/doubleosatoshi', 'Double-O Satoshi', 'Spy shooter: every bullet is a token on chain', 'doubleo'),
  tb('/arcade/bsvgun', 'BSVGun', '3D shooting range where the targets are the live chain', 'bsvgun'),
  tb('/arena', 'Arena', 'DOOM-style maze: fire the tokens in your wallet', 'arena'),
  tb('/arcade/frogger', 'Chain Frogger', 'Cross a 3D city of live mainnet transactions', 'frogger'),
  tb('/arcade/hopper', 'Block Hopper', 'Side-scroller where the level is the live chain', 'hopper'),
  tb('/arcade/invaders', 'Mempool Invaders', '3D shooter where every ship is a live transaction', 'invaders'),
  tb('/arcade/kweg', "Kweg's Expedition", 'Sub through the chain hunting hidden $KWEG', 'kweg'),
  tb('/arcade/snake', 'Token Snake', 'Neon 3D snake: every bite is a real transaction', 'snake'),
  tb('/arcade/city', 'Satoshi City', 'Open-world city where every car is a live tx', 'city'),
  tb('/arcade/npg-cards', 'NPG: Card Battle', 'Ninja Punk Girls card battle, AI or online', 'npg-cards'),
  tb('/arcade/npg-runner', 'NPG: Erobot Uprising', 'Ninja Punk Girls platformer, three bosses', 'npg-runner'),
  tb('/arcade/rally', 'Token Rally', 'Rally racing against live chain traffic', 'rally'),
  tb('/arcade/2048', 'Sat Stack 2048', 'Merge sat stacks up to a 1 BSV tile', '2048'),
  tb('/arcade/highway21', 'Highway 21M', 'OutRun-style racer through live token moves', 'highway21'),
  tb('/arcade/bubbo-bubbo', 'Coin Pop', 'Bubble shooter with token coins', 'bubbo-bubbo'),
  tb('/arcade/puzzling-potions', 'Token Potions', 'Match-3 against a 60-second clock', 'puzzling-potions'),
  tb('/arcade/bracer', 'bRacer', 'Anti-gravity racing at 700 km/h', 'bracer'),
];
