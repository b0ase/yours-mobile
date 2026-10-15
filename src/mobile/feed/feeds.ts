/**
 * The Feed picker: which feeds exist, their colours, the scrolling row and the swipe order.
 *
 * The row at the top of Feed scrolls left / right: Home (Following | For you), bApps (the app reel), the basic suite (bMovies red,
 * bNews green, bMusic blue), then the user's pins (any feed, in pin order), then every other $b* bApp in a
 * fixed order, then "All feeds" (a sheet listing every feed, bApps then Other, where any feed is pinned,
 * unpinned and reordered). Ventures are in the row only when pinned. Pins persist per device. Swiping the feed
 * left / right moves through the row (plus the open feed when it isn't in the row).
 *
 * Every bApp without a custom view shows its bChatX brand account's posts (bchatxFeed.ts). The list is
 * local for now; GET https://www.bchatx.com/api/public/bapps will replace it (see BAPPS_API).
 * bMovies is bWalletX only: its entry is behind BMOVIES_FEED_ENABLED so a store build has none of it.
 * Adult-leaning brands (cherryx, aigf) are left out of every build.
 */
import { BEX_REEL_ENABLED, BMOVIES_FEED_ENABLED } from '../storeBuild';

/** A feed id: the built-in 'home' (Following | For you inside) or a bApp's bChatX brand slug ('bnews', 'bmusic', …). */
export type FeedId = string;

export type FeedGroup = 'core' | 'bapps' | 'other';

export type FeedDef = { id: FeedId; label: string; hint: string; group: FeedGroup; color: string };

/** Feeds with their own view in FeedPage; everything else is a generic bChatX brand-account feed. */
export const CUSTOM_VIEWS: readonly FeedId[] = ['home', 'bapps', 'bnews', 'bmovies', 'bexchange'];

/** Old saved ids for Home's filters (before Following and For you were one chip) → 'home'. */
export const LEGACY_HOME_IDS: readonly string[] = ['following', 'foryou'];
export const migrateFeedId = (id: FeedId): FeedId => (LEGACY_HOME_IDS.includes(id) ? 'home' : id);

/** TODO: when live, load the list from here ([{slug, name, url, avatar, banner, bio, hasPosts}]). */
export const BAPPS_API = 'https://www.bchatx.com/api/public/bapps';

export const GOLD = '#FFD24D';

/** Each bApp's colour: chip / icon ring and the selected state. One map, here. */
export const FEED_COLORS: Record<FeedId, string> = {
  home: GOLD,
  // The basic suite: red, green, blue.
  bmovies: '#E5484D',
  bnews: '#30A46C',
  bmusic: '#3E8BFF',
  bradio: '#F76B15',
  bgame: '#8E4EC6',
  b3d: '#12A594',
  bbooks: '#A18072',
  writer: '#E2B6FF',
  bmail: '#0090FF',
  bsocial: '#D6409F',
  bphotos: '#FFB224',
  bpaint: '#FF8DCC',
  bdrive: '#7CE2FE',
  bsheets: '#46A758',
  bcal: '#FF6369',
  bmaps: '#5BB98B',
  bjobs: '#978365',
  bedu: '#86EAD4',
  bexchange: '#FFE629',
  bmarket: '#F1A10D',
  bdns: '#9E8CFC',
  bfile: '#8DA4EF',
  bidentity: '#BF7AF0',
  bbrowser: '#3DB9CF',
  bitcoincode: '#99D52A',
  bitcoinos: '#C2C2C2',
  bapps: GOLD,
};

/** The colour for a feed: its own, else gold. */
export const feedColor = (id: FeedId): string => FEED_COLORS[id] ?? GOLD;

type Entry = [slug: string, label: string, hint?: string];

const BMOVIES_ENTRY: Entry[] = BMOVIES_FEED_ENABLED ? [['bmovies', 'bMovies', 'Clips from bmovies.app']] : [];
/** Feed › bExchange is the token reel: bWalletX only (BEX_REEL_ENABLED), so a store build has no entry. */
const BEX_ENTRY: Entry[] = BEX_REEL_ENABLED ? [['bexchange', 'bExchange', 'Every token, one card each']] : [];

/** The $b* apps, by bChatX brand slug. */
const BAPP_ENTRIES: Entry[] = [
  ['bapps', 'bApps', 'Apps people build: open, tip, improve'],
  ...BMOVIES_ENTRY,
  ['bnews', 'bNews', 'Headlines to discuss'],
  ['bmusic', 'bMusic', 'New releases'],
  ['bradio', 'bRadio'],
  ['bgame', 'bGames'],
  ['b3d', 'b3D'],
  ['bphotos', 'bPhotos'],
  ['bbooks', 'bBooks'],
  ['writer', 'bWriter'],
  ['bmail', 'bMail'],
  ['bsocial', 'bSocial'],
  ['bpaint', 'bPaint'],
  ['bdrive', 'bDrive'],
  ['bsheets', 'bSheets'],
  ['bcal', 'bCal'],
  ['bmaps', 'bMaps'],
  ['bjobs', 'bJobs'],
  ['bedu', 'bEdu'],
  ...BEX_ENTRY,
  ['bmarket', 'bMarket'],
  ['bdns', 'bDNS'],
  ['bfile', 'bFile'],
  ['bidentity', 'bID'],
  ['bbrowser', 'bBrowser'],
  ['bitcoincode', 'bCode'],
  ['bitcoinos', 'Bitcoin OS'],
];

/** Ventures and the rest, by bChatX brand slug. cherryx and aigf are deliberately absent. */
const OTHER_ENTRIES: Entry[] = [
  ['aibuildersclub', 'AI Builders Club'],
  ['aitribes', 'AI Tribes'],
  ['aivj', 'bTV: AIVJ'],
  ['bcorp', 'Bitcoin Corp'],
  ['bitgit', 'BitGit'],
  ['bsvex', 'BSVEX'],
  ['coursekings', 'CourseKings'],
  ['divvy', 'Divvy'],
  ['dnsdex', 'DNS DEX'],
  ['ffnews', 'FFNEWS'],
  ['floop', 'FLOOP!'],
  ['hyperflix', 'HyperFlix'],
  ['kintsugi', 'Kintsugi'],
  ['kwegwong', 'KWEGWONG'],
  ['metagraph', 'MetaGraph'],
  ['mikrocosm', 'Mikrocosm'],
  ['moneybutton', 'MoneyButton'],
  ['npg', 'Ninja Punk Girls'],
  ['npgx', 'NPGX'],
  ['oneshotcomics', 'One-Shot Comics'],
  ['overnerd', 'overNERD'],
  ['path401', '$401'],
  ['path402', '$402'],
  ['path403', '$403'],
  ['pennypics', 'Penny Pics'],
  ['repodex', 'Repo-DEX'],
  ['scrollpay', 'ScrollPay'],
  ['senseii', 'Senseii'],
  ['tinycapital', 'Tiny Capital'],
  ['tokenblaster', 'TokenBlaster'],
  ['tribeswallet', 'Tribes Wallet'],
  ['tribify', 'Tribify'],
  ['vexvoid', 'VexVoid'],
  ['websitestrategypro', 'WebsiteStrategy Pro'],
];

const def =
  (group: FeedGroup) =>
  ([id, label, hint]: Entry): FeedDef => ({
    id,
    label,
    hint: hint ?? `${label} on bChatX`,
    group,
    color: feedColor(id),
  });

/** Every feed this build has: core, then bApps, then Other. */
export const FEEDS: readonly FeedDef[] = [
  { id: 'home', label: 'Home', hint: 'Following and For you', group: 'core' as const, color: GOLD },
  ...BAPP_ENTRIES.map(def('bapps')),
  ...OTHER_ENTRIES.map(def('other')),
];

/** The "All feeds" sheet's sections. */
export const feedGroups = (feeds: readonly FeedDef[] = FEEDS) => [
  { id: 'bapps' as const, label: 'bApps', feeds: feeds.filter((f) => f.group === 'bapps') },
  { id: 'other' as const, label: 'Other', feeds: feeds.filter((f) => f.group === 'other') },
];

/** Always at the front of the row: Home, then bApps (owner, 15 Oct 2026), then the red / green / blue suite. */
export const FIXED_ROW: readonly FeedId[] = ['home', 'bapps', 'bmovies', 'bnews', 'bmusic'];

/** The fixed order of the other $b* bApps in the row, after the pins (any bApp not listed follows, in FEEDS order). */
export const BAPP_ROW_ORDER: readonly FeedId[] = [
  'bradio',
  'bgame',
  'bart',
  'b3d',
  'bphotos',
  'bbooks',
  'writer',
  'bmail',
  'bsocial',
  'bchatx',
  'bexchange',
  'bjobs',
  'bdrive',
  'bsheets',
  'bcal',
  'bitcoincode',
  'bagents',
  'bpaint',
];

/** A generous cap on pins (any feed, bApp or venture, can be pinned). */
export const MAX_PINNED = 200;

export const isFeedId = (v: unknown, feeds: readonly FeedDef[] = FEEDS): v is FeedId =>
  typeof v === 'string' && feeds.some((f) => f.id === v);

export const feedDef = (id: FeedId, feeds: readonly FeedDef[] = FEEDS): FeedDef =>
  feeds.find((f) => f.id === id) ?? feeds[0];

export const hasCustomView = (id: FeedId) => CUSTOM_VIEWS.includes(id);

/** Known, unique, non-fixed ids only, at most MAX_PINNED (old saved rows with core feeds still load). */
export const cleanPins = (raw: unknown, feeds: readonly FeedDef[] = FEEDS): FeedId[] =>
  (Array.isArray(raw) ? (raw as unknown[]) : [])
    .map((v) => (typeof v === 'string' ? migrateFeedId(v) : v))
    .filter((v, i, a): v is FeedId => isFeedId(v, feeds) && !FIXED_ROW.includes(v) && a.indexOf(v) === i)
    .slice(0, MAX_PINNED);

/** Pin (to the end of the pins, in pin order) or unpin a feed. Fixed feeds are always in the row. */
export const togglePin = (pins: FeedId[], id: FeedId): FeedId[] => {
  if (FIXED_ROW.includes(id)) return pins;
  if (pins.includes(id)) return pins.filter((p) => p !== id);
  return [...pins, id].slice(-MAX_PINNED);
};

/** Move a pin one place earlier (dir -1) or later (dir 1); no-op at either end or when not pinned. */
export const movePin = (pins: FeedId[], id: FeedId, dir: 1 | -1): FeedId[] => {
  const i = pins.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pins.length) return pins;
  const next = [...pins];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

/** Every $b* bApp this build has, in the row's fixed order. */
export const bappRowOrder = (feeds: readonly FeedDef[] = FEEDS): FeedId[] => {
  const bapps = feeds.filter((f) => f.group === 'bapps').map((f) => f.id);
  const rank = (id: FeedId) => {
    const i = BAPP_ROW_ORDER.indexOf(id);
    return i < 0 ? BAPP_ROW_ORDER.length + bapps.indexOf(id) : i;
  };
  return bapps.filter((id) => !FIXED_ROW.includes(id)).sort((a, b) => rank(a) - rank(b));
};

/**
 * The scrolling row (before "All feeds"): the fixed feeds this build has, then the pins (any feed, in pin
 * order), then every other $b* bApp in its fixed order. Each feed appears once; ventures only when pinned.
 */
export const rowFeeds = (pins: FeedId[], feeds: readonly FeedDef[] = FEEDS): FeedId[] => {
  const pinned = pins.filter((id, i) => isFeedId(id, feeds) && !FIXED_ROW.includes(id) && pins.indexOf(id) === i);
  return [
    ...FIXED_ROW.filter((id) => isFeedId(id, feeds)),
    ...pinned,
    ...bappRowOrder(feeds).filter((id) => !pinned.includes(id)),
  ];
};

/** The swipe order: the row, then the open feed when it was opened from All feeds. */
export const swipeOrder = (pins: FeedId[], current: FeedId): FeedId[] => {
  const row = rowFeeds(pins);
  return row.includes(current) ? row : [...row, current];
};

/** The next (dir 1) or previous (dir -1) feed, or null at either end. */
export const stepFeed = (pins: FeedId[], current: FeedId, dir: 1 | -1): FeedId | null => {
  const order = swipeOrder(pins, current);
  return order[order.indexOf(current) + dir] ?? null;
};

/** Horizontal distance (px) past which a swipe changes feed; a mostly vertical drag never does. */
export const FEED_SWIPE_PX = 70;
export const swipeDir = (dx: number, dy: number, threshold = FEED_SWIPE_PX): 1 | -1 | 0 =>
  Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;

// ── persistence (per device) ───────────────────────────────────────────────

export const PINS_KEY = 'bwallet.feed.pins';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const read = (key: string, store: Store | null): unknown => {
  try {
    return JSON.parse(store?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

const write = (key: string, v: unknown, store: Store | null) => {
  try {
    store?.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

export const loadPins = (store = defaultStore()): FeedId[] => cleanPins(read(PINS_KEY, store));
export const savePins = (pins: FeedId[], store = defaultStore()) => write(PINS_KEY, pins, store);
