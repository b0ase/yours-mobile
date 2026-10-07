/**
 * bWalletX-only exchange data: the bExchange bApp and the Markets & collectibles Apps group, icons included.
 * A store build swaps this file for exchangeAppsX.store.ts (vite.config.mobile.ts), so neither the text nor
 * the images are in the store bundle; MARKET_ENABLED gates it as well for builds without the swap.
 */
import { MARKET_ENABLED } from './storeBuild';
import type { BApp } from './bapps';
import type { RadarApp } from './radarApps';
import app_bexchangeIcon from './brand/apps/bexchange.png';
import r_3dordiio from './brand/apps/radar/3dordiio.png';
import r_zoide from './brand/apps/radar/zoide.png';
import r_mintpage from './brand/apps/radar/mintpage.png';
import r_peermark from './brand/apps/radar/peermark.png';
import r_x17b from './brand/apps/radar/x17b.png';
import r_bitcoinisbsvcom from './brand/apps/radar/bitcoinisbsvcom.png';
import r_blackrug from './brand/apps/radar/blackrug.png';
import r_buttercup from './brand/apps/radar/buttercup.png';
import r_canonic from './brand/apps/radar/canonic.png';
import r_copdex from './brand/apps/radar/copdex.png';
import r_everdraw from './brand/apps/radar/everdraw.png';
import r_fundfeature from './brand/apps/radar/fundfeature.png';
import r_home from './brand/apps/radar/home.png';
import r_metamarket from './brand/apps/radar/metamarket.png';
import r_sonicstar from './brand/apps/radar/sonicstar.png';
import r_vibeglowup from './brand/apps/radar/vibeglowup.png';

export const EXCHANGE_BAPPS: BApp[] = MARKET_ENABLED
  ? [
      {
        name: 'bExchange',
        url: 'https://bitcoin-exchange-iota.vercel.app',
        verb: 'Trade tokens across exchanges',
        group: 'social',
        status: 'live',
        icon: app_bexchangeIcon,
        source: 'https://github.com/bitcoin-apps-suite/bitcoin-exchange',
      },
    ]
  : [];

/** Markets & collectibles (the hidden 'market' group): bWalletX only, not in a store bundle even as data. */
export const MARKET_APPS: Omit<RadarApp, 'source'>[] = MARKET_ENABLED
  ? [
      {
        name: '3D Ordi',
        url: 'https://3dordi.io',
        desc: 'Ordinals (NFTs) in Immersive Galleries',
        group: 'market',
        icon: r_3dordiio,
      },
      {
        name: 'Zoide',
        url: 'https://zoide.io',
        desc: 'Non-custodial BSV NFT marketplace with minting, auctions, trading, bulk tools and…',
        group: 'market',
        icon: r_zoide,
      },
      {
        name: 'MintPage',
        url: 'https://mintpage.pro',
        desc: 'Design and deploy on BSV',
        group: 'market',
        icon: r_mintpage,
      },
      {
        name: 'PeerMark',
        url: 'https://beta.peermark.online',
        desc: 'Register, secure and monetise your assets',
        group: 'market',
        icon: r_peermark,
      },
      {
        name: 'X17B',
        url: 'https://www.x17b.com/',
        desc: 'Download Substack content offline',
        group: 'market',
        icon: r_x17b,
      },
      { name: 'BitcoinIsBSV', url: 'http://www.bitcoinisbsv.com', desc: '', group: 'market', icon: r_bitcoinisbsvcom },
      {
        name: 'BlackRug',
        url: 'https://blackrug.org',
        desc: 'Rare Pepe Trading Card Treasury Company',
        group: 'market',
        icon: r_blackrug,
      },
      {
        name: 'ButterCup',
        url: 'https://buttercupdapp.com/',
        desc: 'Build and publish BSV blockchain mini-apps in seconds. Powered by AI, backed by…',
        group: 'market',
        icon: r_buttercup,
      },
      {
        name: 'Canonic.xyz',
        url: 'https://canonic.xyz',
        desc: 'Build and deploy serverless applications on the BSV blockchain',
        group: 'market',
        icon: r_canonic,
      },
      {
        name: 'Copédex',
        url: 'https://copedex.com',
        desc: 'Your one-stop-shop for Rare Pepe authenticity',
        group: 'market',
        icon: r_copdex,
      },
      {
        name: 'Everdraw',
        url: 'https://everdraw.art',
        desc: 'A professional open-source drawing application with blockchain-backed artwork ownership',
        group: 'market',
        icon: r_everdraw,
      },
      {
        name: 'FundFeature',
        url: 'https://fundfeature.com',
        desc: 'Crowdfunding platform for BSV application features',
        group: 'market',
        icon: r_fundfeature,
      },
      {
        name: 'Qart',
        url: 'https://qart.app',
        desc: 'Buy and sell directly with neighbors',
        group: 'market',
        icon: r_home,
      },
      {
        name: 'MetaMarket',
        url: 'https://metamarket.bapp.dev',
        desc: 'Micropayment powered marketplace for buying and selling 3D model files',
        group: 'market',
        icon: r_metamarket,
      },
      {
        name: 'SonicStar',
        url: 'https://sonicstar.net',
        desc: 'Mint your music on the blockchain',
        group: 'market',
        icon: r_sonicstar,
      },
      {
        name: 'VibeGlowUp',
        url: 'https://vibeglowup.com',
        desc: 'AI powered virtual try on clothes, hairstyles, create fantasy outfits. Mint NFTs',
        group: 'market',
        icon: r_vibeglowup,
      },
    ]
  : [];
