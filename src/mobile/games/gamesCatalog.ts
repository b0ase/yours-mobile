/**
 * The bGames catalogue: every game playable now in bWalletX (Apps › Games) and listed on bwalletx.com/games
 * (bwalletx-site keeps a copy). URLs checked 2xx on 7 Oct 2026. Dropped as not answering or no longer a
 * game: CryptoFights, PowChess, SatoPlay (parked domain), Kronoverse, Bitcade, BSV2048.
 *
 * Store builds: no TokenBlaster games (TOKENBLASTER_ENABLED, gamesCatalogX.store.ts) and no game that pays
 * out or stakes real money (`realMoney`, filtered by gamesFor).
 */
import { STORE_BUILD, TOKENBLASTER_ENABLED } from '../storeBuild';
import { TOKENBLASTER_GAMES } from './gamesCatalogX';

export type GameSource = 'b0ase' | 'tokenblaster' | 'third-party';
export type Game = {
  name: string;
  url: string;
  /** One line. */
  desc: string;
  /** Remote image or icon, if the game has one. */
  img?: string;
  source: GameSource;
  /** Pays out or stakes real money: left out of a store build. */
  realMoney?: boolean;
};

export const GAME_SOURCES: { id: GameSource; label: string }[] = [
  { id: 'b0ase', label: 'bGames' },
  // Folds away in a store build, so the name is not in that bundle (docs/STORE-AUDIT.md).
  ...(TOKENBLASTER_ENABLED ? [{ id: 'tokenblaster' as const, label: 'TokenBlaster arcade' }] : []),
  { id: 'third-party', label: 'More BSV games' },
];

const BGAMES = 'https://bitcoin-gaming.vercel.app';
const INSERT_COIN = 'https://insertarcade.com/';

/** Pay out or stake real money: bWalletX only. */
const REAL_MONEY_GAMES: Game[] = [
  {
    name: 'Satoshi Pong',
    url: INSERT_COIN,
    desc: 'Pong where every point is paid on chain',
    source: 'third-party',
    realMoney: true,
  },
  { name: 'FPSV', url: INSERT_COIN, desc: 'First-person arena shooter on BSV', source: 'third-party', realMoney: true },
  { name: 'CHESSV', url: INSERT_COIN, desc: 'Chess on a clock on BSV', source: 'third-party', realMoney: true },
  {
    name: 'Haste Arcade',
    url: 'https://hastearcade.com',
    desc: 'Arcade games with leaderboard payouts',
    source: 'third-party',
    realMoney: true,
  },
  {
    name: '5TARS',
    url: 'https://5tars.io',
    desc: 'Football prediction and fantasy game',
    source: 'third-party',
    realMoney: true,
  },
];

export const GAMES: Game[] = [
  { name: 'Snake', url: BGAMES, desc: 'Eat, grow, don’t hit the walls', source: 'b0ase' },
  { name: '2048', url: BGAMES, desc: 'Merge tiles to reach 2048', source: 'b0ase' },
  {
    name: 'Ninja Punk Girls',
    url: 'https://ninjapunkgirls.online',
    desc: 'Collect and battle cyberpunk NFT cards',
    source: 'b0ase',
  },
  ...(TOKENBLASTER_ENABLED ? TOKENBLASTER_GAMES : []),
  // Not even as data in a store build (STORE_BUILD folds at build time).
  ...(STORE_BUILD ? [] : REAL_MONEY_GAMES),
  {
    name: 'Midnight Pass',
    url: 'https://paiybit.com/paiybit/arcade',
    desc: 'From the Paiybit arcade',
    source: 'third-party',
  },
  {
    name: 'Bitcoin vs. Crypto',
    url: 'https://bitcoinsv.itch.io/bitcoin-versus-crypto',
    desc: 'HTML5 arcade shooter',
    source: 'third-party',
  },
  { name: 'PixelWar', url: 'https://pixelwar.click', desc: 'Collaborative pixel art canvas', source: 'third-party' },
  {
    name: 'Number Cruncher 3D',
    url: 'https://numbercrunchermath.com',
    desc: 'Solve 3D math puzzles',
    source: 'third-party',
  },
  { name: 'Ageless Republic', url: 'https://agelessrepublic.com/', desc: 'Open-world RPG', source: 'third-party' },
  {
    name: 'HyperTypist',
    url: 'https://hypertypist.com/',
    desc: 'Typing speed, records saved on chain',
    source: 'third-party',
  },
  { name: 'PeerJump', url: 'https://peerjump.fun/', desc: 'How high can you climb?', source: 'third-party' },
];

/** The games shown in this build: no real-money games in a store build. */
export const gamesFor = (games: readonly Game[] = GAMES, store = STORE_BUILD): Game[] =>
  store ? games.filter((g) => !g.realMoney && g.source !== 'tokenblaster') : [...games];
