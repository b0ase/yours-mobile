import { MAX_PRIVATE_BYTES } from '../private/privateMint';
import {
  BTRUST_ENABLED,
  GREETING_CARDS_ENABLED,
  MINT_PREVIEWS_ENABLED,
  RELEASES_ENABLED,
  STORE_BUILD,
  USER_NOTES_ENABLED,
} from '../storeBuild';

/**
 * The Mint sheet's tiles and the card behind each one (owner's prototype, 1 Nov 2026: "Mint your digital DNA").
 * Every tile is the same size; tapping one opens a card that sells it (pitch, uses, why, facts) and starts the real
 * flow. Live-only copy: anything that does not work yet is marked not open yet, and that text lives behind
 * MINT_PREVIEWS_ENABLED so a store build carries none of it (docs/STORE-AUDIT.md). Bought-from-bCorp flows (AI
 * pictures, greeting cards) sit behind GREETING_CARDS_ENABLED; bWalletX-only flows behind !STORE_BUILD.
 *
 * Pure data: MintChooser.tsx draws it, MintButton.tsx runs the actions.
 */

/** What a tile, a use or a card's main button does. */
export type MintAction =
  /** A flow in MintButton's MINT_TILES (media picker, ticket, token, domain, a b draft, agent account). */
  | { flow: string }
  /** A wallet route (closes the sheet). */
  | { go: string }
  /** Pick any one file from a data download: photo, video, audio, chat export or document. */
  | { upload: true }
  /** Not open yet (only ever in MINT_PREVIEWS_ENABLED builds). */
  | { soon: true };

export type MintIconId =
  | 'link'
  | 'upload'
  | 'spark'
  | 'card'
  | 'pic'
  | 'music'
  | 'film'
  | 'box'
  | 'book'
  | 'globe'
  | 'note'
  | 'coin'
  | 'ticket'
  | 'at'
  | 'sign'
  | 'chart'
  | 'app'
  | 'bot'
  | 'brain'
  | 'swap'
  | 'drive'
  | 'tree';

export type MintUse = { id: string; title: string; sub: string; action: MintAction };

/**
 * One of our services a card belongs to, drawn as its wordmark (lowercase b, gold X) under the card's art and on its
 * tile. `site` is the domain the chip opens: bWalletX only (SITES below), so a store build shows the name and never a
 * link to an outside site (Apple 3.1.1, Play Payments).
 */
export type MintBrand = { name: string; role?: string; site?: string };

export type MintCard = {
  id: string;
  icon: MintIconId;
  title: string;
  sub: string;
  /** The tile's own status: the main thing is not open yet (some uses may still be live). */
  soon?: boolean;
  /** Dark colour behind the card's art. */
  tint: string;
  pitch: string;
  uses?: MintUse[];
  /** True today. */
  why: string[];
  /** Planned, shown under "Not open yet" (empty in a store build). */
  later?: string[];
  facts: { who: string; cost: string; where: string };
  /** The main button when the card has no uses (otherwise the first live use). */
  cta?: MintAction;
  ctaLabel?: string;
  /** The services it belongs to (wordmarks). */
  brands?: MintBrand[];
};

const MB = 1024 * 1024;
const PRIVATE_LIMIT = `${Math.round(MAX_PRIVATE_BYTES / MB)} MB`;
const PRIV = 'Only you. Encrypted to your wallet before it goes on chain.';
const SIZE = 'Priced by file size. You see the exact price before you pay.';
const VAULT = 'bMint › Your vault, or your Media tab if you make it public.';
const SOON: MintAction = { soon: true };

/**
 * Our services' sites (owner, 1 Nov 2026; each checked live with its own page). Not in a store build, not even as
 * text: the names stay, the links go. 3D models is bModelX; b3dx.com and bcorpx.com are not ours, never use them.
 */
const SITES: Record<string, string> = !STORE_BUILD
  ? {
      bMusicX: 'bmusicx.com',
      bVideoX: 'bvideox.com',
      bMoviesX: 'bmoviesx.com',
      bPicsX: 'bpicsx.com',
      bWriterX: 'bwriterx.com',
      bDriveX: 'bdrivex.com',
      bVaultX: 'bvaultx.com',
      bStoreX: 'bstorex.com',
      bMarketX: 'bmarketx.com',
      bJobsX: 'bjobsx.com',
      bModelX: 'bmodelx.com',
    }
  : {};
export const brand = (name: string, role?: string): MintBrand => ({
  name,
  ...(role ? { role } : {}),
  ...(SITES[name] ? { site: SITES[name] } : {}),
});

export const MINT_CARDS: MintCard[] = [
  // ── Your past, from the apps you use ──────────────────────────────────────────────────────────────────────
  ...(MINT_PREVIEWS_ENABLED
    ? [
        {
          id: 'link',
          icon: 'link' as const,
          title: 'Link an account',
          sub: 'Fingerprint every post',
          soon: true,
          cta: SOON,
          tint: '#2a210a',
          pitch:
            'Sign in once. Every post you ever made is fingerprinted on chain, signed by you, and new posts are added as you go.',
          why: [
            'Proof it’s yours and when you posted it, even if the platform deletes it',
            'A fraction of a cent per post',
            'Your posts stay where they are; nothing is copied',
          ],
          facts: {
            who: 'The fingerprints are public; they reveal nothing about the content.',
            cost: 'A fraction of a cent per post.',
            where: 'Fingerprints on chain, signed by your identity key.',
          },
        },
      ]
    : []),
  {
    id: 'upload',
    brands: [brand('bDriveX', 'storage')],
    icon: 'upload',
    title: 'Upload your archive',
    sub: 'Keep the real thing',
    tint: '#0b2230',
    cta: { upload: true },
    ctaLabel: 'Pick a file from your download',
    pitch:
      'Download your data from any app, then pick a photo, video, chat or document from it. It’s encrypted to your wallet before it goes on chain, so only you can open it.',
    uses: [
      {
        id: 'file',
        title: 'A photo, video or document',
        sub: 'Any one file from your download',
        action: { upload: true },
      },
      { id: 'chat', title: 'A chat or thread', sub: 'A WhatsApp or Telegram export (.txt)', action: { flow: 'books' } },
      ...(MINT_PREVIEWS_ENABLED
        ? [
            { id: 'whole', title: 'A whole archive', sub: 'The zip the app sends you, in one go', action: SOON },
            { id: 'folder', title: 'A folder of files', sub: 'Many photos at once', action: SOON },
          ]
        : []),
    ],
    why: [
      'Yours even if the app disappears or locks you out',
      'Only you can open it: it’s encrypted on this device first',
      'Reveal it later, if you ever want to show it',
    ],
    later: MINT_PREVIEWS_ENABLED
      ? ['Your agent can learn from it, with your permission', 'Hand it down to your heirs']
      : [],
    facts: {
      who: PRIV,
      cost: `${SIZE} Up to ${PRIVATE_LIMIT} a file for now.`,
      where: 'Encrypted on chain; it shows in bMint › Your vault.',
    },
  },

  // ── Make something new ─────────────────────────────────────────────────────────────────────────────────────
  ...(GREETING_CARDS_ENABLED
    ? [
        {
          id: 'picture',
          brands: [brand('bPicsX')],
          icon: 'spark' as const,
          title: 'AI pictures',
          sub: 'Describe it, b paints it',
          tint: '#2c1f05',
          pitch:
            'Describe a picture and b paints it. Keep the ones you love and mint them in your name, privately or for everyone.',
          uses: [
            {
              id: 'one',
              title: 'One picture',
              sub: 'Describe it, then mint the one you like',
              action: { flow: 'picture' },
            },
            ...(MINT_PREVIEWS_ENABLED
              ? [
                  { id: 'series', title: 'A series', sub: 'The same idea, a little different each time', action: SOON },
                  {
                    id: 'style',
                    title: 'In your style',
                    sub: 'b learns from pictures you’ve already minted',
                    action: SOON,
                  },
                ]
              : []),
          ],
          why: [
            'A gallery that’s provably yours, dated on chain',
            'Private until you choose to show it',
            'Make as many as you like',
          ],
          later: MINT_PREVIEWS_ENABLED ? ['Sell or license your pictures on BSVEX'] : [],
          facts: {
            who: 'Private until you choose to show it.',
            cost: 'b shows the price of each picture before you pay, then the mint.',
            where: VAULT,
          },
        },
        {
          id: 'card',
          icon: 'card' as const,
          title: 'Greeting cards',
          sub: 'Birthdays, Christmas, thanks',
          tint: '#2c0f18',
          pitch: 'b makes a card for the moment, you mint it, then send it to their $name.',
          uses: [
            {
              id: 'now',
              title: 'Send a card now',
              sub: 'Describe it, b makes it, send it to their $name',
              action: { flow: 'card' },
            },
            ...(MINT_PREVIEWS_ENABLED
              ? [
                  {
                    id: 'yearly',
                    title: 'Send one every year',
                    sub: 'Pick who and when; a small pot pays for each card',
                    action: SOON,
                  },
                  { id: 'gift', title: 'A card with a gift', sub: 'BSV, a token or a ticket inside', action: SOON },
                ]
              : []),
          ],
          why: [
            'A card that’s theirs for good, not a message that scrolls away',
            'Made for the person and the moment',
            'They can wear it as their bAvatar',
          ],
          facts: {
            who: 'You, then the person you send it to.',
            cost: 'b shows the price of the card before you pay, then the mint.',
            where: 'Your wallet, then theirs when you send it.',
          },
        },
      ]
    : []),
  {
    id: 'art',
    brands: [brand('bPicsX')],
    icon: 'pic',
    title: 'Art & photos',
    sub: 'One-offs or a numbered set',
    tint: '#0e2233',
    pitch: 'Mint your photos and artwork as one-of-a-kind pieces or numbered editions, with your name on every one.',
    uses: [
      { id: 'one', title: 'One of a kind', sub: 'A single piece', action: { flow: 'art' } },
      { id: 'edition', title: 'A numbered edition', sub: '1 of 50, 1 of 100… (public mints)', action: { flow: 'art' } },
      { id: 'private', title: 'Private photos', sub: 'Encrypted, for your eyes only', action: { flow: 'art' } },
    ],
    why: [
      'Your authorship, signed and dated on chain',
      'Private by default; public only if you choose',
      'Numbered editions for collectors',
    ],
    later: MINT_PREVIEWS_ENABLED ? ['Sell editions on BSVEX', 'Family albums passed on to your heirs'] : [],
    facts: { who: 'Private by default; reveal it any time.', cost: SIZE, where: VAULT },
  },
  {
    id: 'music',
    brands: [brand('bMusicX')],
    icon: 'music',
    title: 'Music',
    sub: 'Tracks fans own and play',
    tint: '#1a1033',
    pitch: 'Mint a track with its artist, album and cover art. Fans who hold a copy play it in their wallet.',
    uses: [
      { id: 'single', title: 'A track', sub: 'One track, with cover art', action: { flow: 'music' } },
      ...(RELEASES_ENABLED
        ? [
            {
              id: 'release',
              title: 'A release',
              sub: 'A single or album, listed in bMusic',
              action: { go: '/m/media/new' },
            },
          ]
        : []),
      ...(MINT_PREVIEWS_ENABLED
        ? [
            {
              id: 'versions',
              title: 'Versions & remixes',
              sub: 'License your track; makers share income with you',
              action: SOON,
            },
          ]
        : []),
    ],
    why: ['Your name and the date on every copy', 'Numbered editions for fans', 'Plays in Media › Music'],
    later: MINT_PREVIEWS_ENABLED ? ['Paid per second of listening', 'License versions and remixes for a share'] : [],
    facts: { who: 'Private by default; public when you release it.', cost: SIZE, where: VAULT },
  },
  {
    id: 'video',
    brands: [brand('bVideoX', 'clips'), brand('bMoviesX', 'films')],
    icon: 'film',
    title: 'Videos & films',
    sub: 'Clips to full films',
    tint: '#2a0e0e',
    pitch: 'Mint a clip, a short or a whole film with a cover frame, and keep the record of who made it.',
    uses: [
      { id: 'clip', title: 'A clip or short', sub: 'Up to a few minutes', action: { flow: 'video' } },
      { id: 'film', title: 'A film', sub: 'A short or a feature, within the size limit', action: { flow: 'video' } },
      ...(MINT_PREVIEWS_ENABLED
        ? [{ id: 'musicvideo', title: 'A music video', sub: 'Linked to a track you minted', action: SOON }]
        : []),
    ],
    why: [
      'Signed and dated: the record of who made it',
      'Private by default; public when you release it',
      'Pick any frame as the cover',
    ],
    later: MINT_PREVIEWS_ENABLED ? ['Listed on bMoviesX or bVideoX', 'Paid per view or per second'] : [],
    facts: { who: 'Private by default; public when you release it.', cost: SIZE, where: VAULT },
  },
  {
    id: '3d',
    brands: [brand('bModelX')],
    icon: 'box',
    title: '3D models',
    sub: 'GLB, glTF or USDZ',
    tint: '#10261c',
    pitch: 'Mint 3D models people can spin in their wallet: characters, products, scans of real things.',
    cta: { flow: '3d' },
    ctaLabel: 'Pick a model',
    why: ['Your design, signed and dated', 'A cover picture is drawn for you', 'Scans of heirlooms kept privately'],
    later: MINT_PREVIEWS_ENABLED ? ['Sell or license your models on BSVEX'] : [],
    facts: { who: 'Private by default.', cost: SIZE, where: VAULT },
  },
  {
    id: 'books',
    brands: [brand('bWriterX')],
    icon: 'book',
    title: 'Writing & documents',
    sub: 'Books, ideas, inventions',
    tint: '#25200c',
    pitch:
      'Mint your writing, notes, designs and inventions. The date is proven the moment you mint, and only you can read it.',
    uses: [
      { id: 'book', title: 'A book or essay', sub: 'Ebook, PDF or text', action: { flow: 'books' } },
      { id: 'idea', title: 'An idea or invention', sub: 'Timestamp it before you share it', action: { flow: 'books' } },
      { id: 'journal', title: 'Journals & notes', sub: 'Private, just for you', action: { flow: 'books' } },
    ],
    why: [
      'Proof you had it first, dated on chain',
      'Only you can read it: it’s encrypted on this device',
      'Reveal it when you choose',
    ],
    later: MINT_PREVIEWS_ENABLED ? ['Your agent can learn how you think', 'Hand your ideas down to your heirs'] : [],
    facts: { who: PRIV, cost: SIZE, where: 'Encrypted on chain; it shows in bMint › Your vault.' },
  },
  {
    id: 'website',
    icon: 'globe',
    title: 'A website',
    sub: 'On chain for good',
    tint: '#0b2433',
    pitch: 'Mint a one-page site that stays up for good: no hosting bills, and nobody can take it down.',
    cta: { flow: 'website' },
    ctaLabel: 'Pick an HTML page',
    why: ['A permanent link', 'No hosting to pay for', 'Signed by you'],
    later: MINT_PREVIEWS_ENABLED ? ['Served at your $name'] : [],
    facts: { who: 'Public: websites are meant to be read.', cost: SIZE, where: 'On chain, at a permanent link.' },
  },

  // ── Money & identity ───────────────────────────────────────────────────────────────────────────────────────
  ...(MINT_PREVIEWS_ENABLED
    ? [
        {
          id: 'currency',
          icon: 'note' as const,
          title: 'Mint a currency',
          sub: 'Your own notes and coins',
          tint: '#2a2005',
          pitch:
            'Issue your own numbered notes and coins. Give them to fans, reward friends or collect them. Every one is signed by you.',
          uses: [
            {
              id: 'notes',
              title: 'Notes',
              sub: 'PoW notes in the note design: 1K, 10K, 100K, 1M',
              action: USER_NOTES_ENABLED ? { go: '/m/bmint/make' } : SOON,
            },
            {
              id: 'coins',
              title: 'Coins',
              sub: 'Your bAvatar minted as a numbered coin',
              action: { go: '/m/bmint/mint/bavatar' },
            },
            {
              id: 'reward',
              title: 'Reward someone',
              sub: 'Send the next note in your series as a thank-you',
              action: SOON,
            },
          ],
          why: [
            'Numbered and signed by you',
            'Anyone can check they’re genuine',
            'Collectibles: they don’t promise any value',
          ],
          later: ['Each serial can carry the next step of an evolving AI artwork'],
          facts: {
            who: 'Public, so people can check they’re genuine.',
            cost: 'Shown before you pay.',
            where: 'Your wallet.',
          },
        },
      ]
    : []),
  {
    id: 'token',
    brands: !STORE_BUILD ? [brand('bWalletX Exchange')] : [],
    icon: 'coin',
    title: 'A token',
    sub: 'Your own coin, fixed supply',
    tint: '#1f1a05',
    pitch: 'Launch your own token with a fixed supply, minted straight from your wallet.',
    cta: { flow: 'coin' },
    ctaLabel: 'Make the token',
    why: [
      'You choose the name, ticker, supply and icon',
      'Send it to anyone with a $name or an address',
      ...(!STORE_BUILD
        ? ['Comes with a chat room where holders meet', 'Tokens can lose all their value: no promises']
        : []),
    ],
    facts: { who: 'Public.', cost: 'Shown before you pay.', where: 'Your wallet.' },
  },
  ...(!STORE_BUILD
    ? [
        {
          id: 'tickets',
          brands: [brand('bWalletX Exchange')],
          icon: 'ticket' as const,
          title: 'Tickets & passes',
          sub: 'Entry to rooms and events',
          tint: '#16220a',
          pitch: 'Mint tickets for your chat room or event. Holders get in, and the room opens with them.',
          cta: { flow: 'tickets' },
          ctaLabel: 'Start a room',
          why: [
            'Each ticket is checked on chain: no fakes',
            'You set how many there are',
            'Add an event date and a price',
          ],
          facts: { who: 'Public.', cost: 'Shown before you pay.', where: 'Your holders’ wallets.' },
        },
      ]
    : []),
  {
    id: 'name',
    brands: [brand('OpNS')],
    icon: 'at',
    title: 'Your name',
    sub: 'A name or a domain',
    tint: '#0d2a22',
    pitch: 'Claim your name on Bitcoin, or prove you own a web domain and tokenise it.',
    uses: [
      { id: 'name', title: 'A name on Bitcoin', sub: 'Search, buy or claim one. From $1', action: { go: '/m/names' } },
      ...(!STORE_BUILD
        ? [
            {
              id: 'handle',
              title: 'Your $handle',
              sub: 'name@bwalletx.com, where people pay you',
              action: { go: '/m/bmint/mint/handle' },
            },
          ]
        : []),
      { id: 'domain', title: 'A domain you own', sub: 'Prove it, then tokenise it', action: { flow: 'domain' } },
    ],
    why: ['People can find and pay you by name', 'It’s yours, held in your wallet', 'Easy to say, easy to remember'],
    later: MINT_PREVIEWS_ENABLED ? ['Your agent answers to it', 'Hand it down to your heirs'] : [],
    facts: { who: 'Public.', cost: 'Shown before you pay.', where: 'Your wallet.' },
  },

  // ── Work (bWalletX only) ──────────────────────────────────────────────────────────────────────────────────
  ...(!STORE_BUILD
    ? [
        {
          id: 'contract',
          icon: 'sign' as const,
          title: 'Contracts',
          sub: 'Agreements both sides sign',
          tint: '#1d1d0a',
          pitch:
            'Tell b who it’s between and what each side agrees to. b drafts the agreement for you to check, then mint.',
          cta: { flow: 'contract' },
          ctaLabel: 'Ask b to draft it',
          why: [
            'Signed and dated on chain',
            'b asks the right questions: who, what, the price and the dates',
            'You check every word before anything is minted',
          ],
          later: MINT_PREVIEWS_ENABLED ? ['Payments that run on schedule by themselves'] : [],
          facts: { who: 'You and the other party.', cost: 'Shown before you mint.', where: 'Your wallet.' },
        },
        {
          id: 'strategy',
          icon: 'chart' as const,
          title: 'Trading strategies',
          sub: 'Package one others can buy',
          tint: '#0d1d2a',
          pitch:
            'Turn a trading strategy into something others can buy. b helps you write the rules: which tokens, the budget, when it stops and the price.',
          cta: { flow: 'strategy' },
          ctaLabel: 'Ask b to help',
          why: [
            'You keep the logic; buyers get access',
            'b asks what it does and when it stops',
            'Signed and dated on chain',
          ],
          later: MINT_PREVIEWS_ENABLED ? ['Runs in buyers’ wallets', 'Listed on BSVEX'] : [],
          facts: { who: 'Only the people who buy it.', cost: 'Shown before you mint.', where: 'Your wallet.' },
        },
        {
          id: 'app',
          icon: 'app' as const,
          title: 'An app',
          sub: 'List your bApp with a token',
          tint: '#1a1230',
          pitch:
            'List your app as a bApp with its own token. b asks for the name, the website and what the token does.',
          cta: { flow: 'app' },
          ctaLabel: 'Ask b to list it',
          why: ['Your app, signed and dated', 'b drafts the listing with you', 'Its own token, from day one'],
          later: MINT_PREVIEWS_ENABLED ? ['Users pay in one tap', 'A room for your users'] : [],
          facts: { who: 'Public.', cost: 'Shown before you pay.', where: 'Your wallet.' },
        },
        {
          id: 'tradebot',
          icon: 'bot' as const,
          title: 'Trading agent account',
          sub: 'A wallet your bot trades from',
          tint: '#101a26',
          pitch:
            'A separate account in your wallet for an agent that trades at machine speed, kept apart from your main money.',
          cta: { flow: 'agent-account' },
          ctaLabel: 'Create the account',
          why: ['Kept apart from your main money', 'Stop its spending any time', 'Move money back to you in one tap'],
          facts: { who: 'You.', cost: 'Free to create.', where: 'A new account in your wallet.' },
        },
      ]
    : []),

  // ── Use what you've minted ─────────────────────────────────────────────────────────────────────────────────
  ...(MINT_PREVIEWS_ENABLED
    ? [
        {
          id: 'agent',
          icon: 'brain' as const,
          title: 'Your agent',
          sub: 'Knows you, acts for you',
          soon: true,
          tint: '#251433',
          pitch:
            'Give an agent selective access to what you’ve minted (your posts, preferences, ideas) so it can act as you would, in your interest.',
          uses: [
            { id: 'grant', title: 'Choose what it can read', sub: 'Posts, photos, writing, preferences', action: SOON },
            {
              id: 'tasks',
              title: 'What it does for you',
              sub: 'Replies, shopping, research, negotiating',
              action: SOON,
            },
            { id: 'limits', title: 'Its limits', sub: 'Spending caps and things it must ask about', action: SOON },
          ],
          why: [
            'You choose exactly what it can read',
            'It answers, shops and negotiates the way you would',
            'Take access back with one tap',
          ],
          facts: {
            who: 'Only the agent you grant, only what you grant.',
            cost: 'Pay as you use it.',
            where: 'Runs in your bWalletX.',
          },
        },
        {
          id: 'sell',
          brands: [brand('bStoreX', 'your shop'), brand('bMarketX', 'the market')],
          icon: 'swap' as const,
          title: 'Sell or license it',
          sub: 'On BSVEX',
          soon: true,
          tint: '#0a2520',
          pitch: 'List anything you minted on BSVEX: art, music, films, notes, even your own data, on your terms.',
          uses: [
            { id: 'list', title: 'List an item', sub: 'Set a price for something you minted', action: SOON },
            { id: 'license', title: 'License it', sub: 'Let others use it for a share', action: SOON },
            {
              id: 'data',
              title: 'Your data price card',
              sub: 'Ads, research and reveals at your prices',
              action: SOON,
            },
          ],
          why: [
            'Set your price once; sales happen by themselves',
            'License instead of selling outright',
            'Your data: you choose who, what and the price',
          ],
          facts: { who: 'Buyers see only what you list.', cost: 'A small fee on each sale.', where: 'bsvex.com' },
        },
        {
          id: 'keep',
          brands: [brand('bVaultX')],
          icon: 'drive' as const,
          title: 'Keep it for good',
          sub: 'Long-term storage',
          soon: true,
          cta: SOON,
          tint: '#0a2228',
          pitch:
            'Big files (videos, full archives) kept by bDriveX under a storage contract you prepay, so they outlive any device.',
          why: [
            'Prepay for years in one go',
            'Encrypted: the storage can’t read it',
            'Renew it, or hand the contract down',
          ],
          facts: { who: PRIV, cost: 'A yearly price per GB, shown first.', where: 'bDriveX, linked from your wallet.' },
        },
      ]
    : []),
  ...(BTRUST_ENABLED
    ? [
        {
          id: 'heirs',
          brands: [brand('bTrust', 'in bWalletX')],
          icon: 'tree' as const,
          title: 'Hand it down',
          sub: 'Your heirs, in bTrust',
          tint: '#1d2a0e',
          pitch:
            'Choose who inherits what. bTrust seals your important papers and builds a plan your heirs open together, with key slices, not with us.',
          uses: [
            {
              id: 'papers',
              title: 'Important papers',
              sub: 'Seal documents your heirs open together',
              action: { go: '/m/btrust' },
            },
            {
              id: 'plan',
              title: 'Passing on',
              sub: 'A timelocked plan: 2 of 3 heirs, then a lead heir',
              action: { go: '/m/btrust' },
            },
            ...(MINT_PREVIEWS_ENABLED
              ? [
                  {
                    id: 'minted',
                    title: 'What you’ve minted',
                    sub: 'Photos, writing and videos from your vault',
                    action: SOON,
                  },
                ]
              : []),
          ],
          why: [
            'Each heir gets only what you chose',
            'Opened by key slices, not by us',
            'Everything runs on your device',
          ],
          later: MINT_PREVIEWS_ENABLED ? ['A letter or video your heirs see first'] : [],
          facts: {
            who: 'Nobody until it opens; then only the heirs you named.',
            cost: 'Network fees, shown before you pay.',
            where: 'bTrust, in your wallet.',
          },
        },
      ]
    : []),
];

/** The sheet's sections, in order. Ids that aren't in this build's MINT_CARDS are skipped. */
export const MINT_SECTIONS: { id: string; title: string; cards: string[]; brand?: MintBrand }[] = [
  {
    id: 'make',
    title: 'Make something new',
    cards: ['picture', 'card', 'art', 'music', 'video', '3d', 'books', 'website'],
  },
  { id: 'money', title: 'Money & identity', cards: ['currency', 'token', 'tickets', 'name'] },
  // Every card in these two is bWalletX only, so a store build drops the headings too.
  ...(!STORE_BUILD
    ? [
        { id: 'work', title: 'Work', cards: ['contract', 'strategy', 'app', 'tradebot'], brand: brand('bJobsX') },
        { id: 'use', title: 'Use what you’ve minted', cards: ['heirs', 'agent', 'sell', 'keep'] },
      ]
    : []),
];

/** The two ways in, above the apps: Link an account (not open yet) and Upload your archive. */
export const MINT_WAYS = ['link', 'upload'];

export const mintCard = (id: string) => MINT_CARDS.find((c) => c.id === id);

/** The service an app's posts belong with (its card's brand strip). */
export const APP_BRANDS: Record<string, MintBrand[]> = {
  linkedin: [brand('bJobsX', 'work history')],
  instagram: [brand('bPicsX')],
  flickr: [brand('bPicsX')],
  pinterest: [brand('bPicsX')],
  icloud: [brand('bPicsX')],
  soundcloud: [brand('bMusicX')],
  bandcamp: [brand('bMusicX')],
  youtube: [brand('bVideoX')],
  tiktok: [brand('bVideoX')],
  twitch: [brand('bVideoX')],
  vimeo: [brand('bVideoX'), brand('bMoviesX')],
  substack: [brand('bWriterX')],
  medium: [brand('bWriterX')],
  takeout: [brand('bDriveX', 'storage')],
};
