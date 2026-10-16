import { TOKENBLASTER_ENABLED } from '../storeBuild';

/**
 * Our games, shown as cards under Exchange › Games (owner, 17 Oct 2026). There is no games feed yet, so this is a
 * small static copy of the live cabinets in tokenblaster.lol's src/lib/games.ts (titles, routes, kinds). Replace it
 * with that site's public list when one exists. `token` is the game's own token ticker, when it has one; the Games
 * view links it to the token's market row if the board knows that ticker.
 *
 * bWalletX only: tokenblaster.lol charges per action, so like the TokenBlaster tile this list folds to [] in a store
 * build (TOKENBLASTER_ENABLED) and the data is not in that bundle.
 */
export type OurGame = { title: string; kind: string; url: string; blurb: string; token?: string };

const TB = 'https://www.tokenblaster.lol';

export const OUR_GAMES: readonly OurGame[] = TOKENBLASTER_ENABLED
  ? [
      {
        title: 'Ninja Punk Girls: Arena',
        kind: '3D fighter',
        url: `${TB}/arcade/npg-arena`,
        blurb: 'Twelve Ninja Punk Girls, one-on-one. Penny Battles: 1p coins are energy bars.',
        token: '$NPG',
      },
      {
        title: 'Ninja Punk Girls: Card Battle',
        kind: 'card battle',
        url: `${TB}/arcade/npg-cards`,
        blurb: 'Build a deck of NPG element cards; every card played is a transaction.',
        token: '$NPG',
      },
      {
        title: 'Ninja Punk Girls: Erobot Uprising',
        kind: 'platformer',
        url: `${TB}/arcade/npg-runner`,
        blurb: 'Wall-jump, dash and shuriken through three stages and three Erobot bosses.',
        token: '$NPG',
      },
      {
        title: 'Chain Frogger',
        kind: '3D city crosser',
        url: `${TB}/arcade/frogger`,
        blurb: 'Every vehicle is a live mainnet transaction. 1 sat per hop.',
      },
      {
        title: 'bRacer',
        kind: 'anti-gravity racer',
        url: `${TB}/arcade/bracer`,
        blurb: 'Anti-gravity racing at 700 km/h; every rival ship is a mainnet transaction.',
      },
      {
        title: 'Arena',
        kind: 'hell-forge shooter',
        url: `${TB}/arena`,
        blurb: 'Fire the tokens in your wallet: every bullet is a real transaction. Multiplayer.',
      },
      {
        title: 'Double-O Satoshi',
        kind: 'spy shooter',
        url: `${TB}/arcade/doubleosatoshi`,
        blurb: 'Special Agent Kweg Wong fires PNEE at parody crypto villains across five missions.',
      },
      {
        title: 'BSVGun',
        kind: '3D shooting range',
        url: `${TB}/arcade/bsvgun`,
        blurb: 'The targets are the live chain.',
      },
      {
        title: 'Mempool Invaders',
        kind: '3D shooter',
        url: `${TB}/arcade/invaders`,
        blurb: 'Every ship is a live transaction; shoot gold token ships.',
      },
      {
        title: 'Block Hopper',
        kind: 'side-scroller',
        url: `${TB}/arcade/hopper`,
        blurb: 'The level is the live chain: txs are ground, blocks are checkpoints.',
      },
      {
        title: "Kweg's Expedition",
        kind: 'side-scroller',
        url: `${TB}/arcade/kweg`,
        blurb: "Pilot Professor Kweg's submarine and sonar for hidden $KWEG.",
        token: '$KWEG',
      },
      { title: 'Token Snake', kind: '3D snake', url: `${TB}/arcade/snake`, blurb: 'Every bite is a real transaction.' },
      {
        title: 'Satoshi City',
        kind: 'open-world city',
        url: `${TB}/arcade/city`,
        blurb: 'Every car on the road is a live mainnet transaction.',
      },
      { title: 'Token Rally', kind: '3D rally', url: `${TB}/arcade/rally`, blurb: 'Every rival car is a transaction.' },
      {
        title: 'Highway 21M',
        kind: 'arcade racer',
        url: `${TB}/arcade/highway21`,
        blurb: 'OutRun-style racer on live traffic.',
      },
      {
        title: 'Sat Stack 2048',
        kind: 'puzzle',
        url: `${TB}/arcade/2048`,
        blurb: 'Merge sat stacks up to a 1 BSV tile.',
      },
      {
        title: 'Coin Pop',
        kind: 'bubble shooter',
        url: `${TB}/arcade/bubbo-bubbo`,
        blurb: 'Bubble shooter with token coins.',
      },
      {
        title: 'Token Potions',
        kind: 'match-3',
        url: `${TB}/arcade/puzzling-potions`,
        blurb: 'Match-3 on a 60-second clock.',
      },
    ]
  : [];
