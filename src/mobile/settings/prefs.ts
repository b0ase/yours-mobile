/**
 * bWallet app preferences (Feed / Payments / Media). Device-wide localStorage, like the rest of the feed
 * state (follows, mutes, likes): these are UI choices, not keys or balances.
 *
 * Default feed mapping (what the Feed tab opens to):
 *   - 'following' → Following tab; falls back to Latest when you follow nobody (the old behaviour, and the default)
 *   - 'latest'    → For you tab, sorted by newest
 *   - 'foryou'    → For you tab, ranked by BSV locked behind each post
 */
import { CATEGORIES, type NotifyCategory } from '../notify/notify';

export type DefaultFeed = 'foryou' | 'latest' | 'following';
export const ONE_CLICK_LIMITS = [100, 1_000, 10_000] as const;
export type OneClickLimit = (typeof ONE_CLICK_LIMITS)[number];
export const INDEX_AUTOPAY_USD = [0, 0.05, 0.1, 0.25] as const;
/** Paid-like amounts offered in Settings → Payments (sats; ≥ 546 dust, BCHAT-PROTOCOL-v2 §5). */
export const PAID_LIKE_OPTIONS = [1_000, 5_000, 10_000, 50_000] as const;
export type IndexAutoPayUsd = (typeof INDEX_AUTOPAY_USD)[number];

export type Prefs = {
  defaultFeed: DefaultFeed;
  /** Feed videos start (muted) when scrolled into view. Off: tap to play. */
  autoplay: boolean;
  /** Skip the confirm step for small paying actions, up to `oneClickLimit` sats each. */
  oneClick: boolean;
  oneClickLimit: OneClickLimit;
  /** Amount a one-click tip sends (the last amount you tipped from the tip sheet). */
  quickTip: number;
  /** Sats a paid like sends to the post's author (default 1,000; free likes stay free). */
  paidLikeSats: number;
  /**
   * Indexing fees for your own tokens under this many USD pay on one tap (no confirm sheet).
   * 0 = always confirm. Guarded like one-click pay (src/mobile/tokens/indexAutoPay.ts).
   */
  indexAutoPayUsd: IndexAutoPayUsd;
  /** Looping video behind Apps, Wallet and Feed. Off: still image only. */
  animatedBackgrounds: boolean;
  /** Notifications per category (Settings → Notifications). */
  notify: Record<NotifyCategory, boolean>;
  /** Your Twetch user number (twetch.com/u/<n>), so replies on Twetch reach you. Empty: unknown. */
  twetchUserId: string;
  /** "Filter strong language": blur swearing in the Feed behind "Show anyway" (feed/language.ts). Off by default. */
  filterStrong: boolean;
  /** "Sounds" (Settings › Preferences): the coin chime on the Sent! screen. On by default. */
  sounds: boolean;
};

const ALL_ON = Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<NotifyCategory, boolean>;

export const DEFAULT_PREFS: Prefs = {
  defaultFeed: 'following',
  autoplay: false,
  oneClick: false,
  oneClickLimit: 1_000,
  quickTip: 1_000,
  paidLikeSats: 1_000,
  animatedBackgrounds: true,
  indexAutoPayUsd: 0.1,
  notify: ALL_ON,
  twetchUserId: '',
  filterStrong: false,
  sounds: true,
};

const KEY = 'bwallet.prefs';
const EVENT = 'bwallet-prefs';

const parseNotify = (raw: unknown): Record<NotifyCategory, boolean> => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(CATEGORIES.map((c) => [c, typeof r[c] === 'boolean' ? r[c] : true])) as Record<
    NotifyCategory,
    boolean
  >;
};

/** Validates stored JSON field by field so a bad / old value falls back to its default, never crashes. */
export const parsePrefs = (raw: unknown): Prefs => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const feed = r.defaultFeed;
  const limit = r.oneClickLimit;
  const tip = r.quickTip;
  return {
    defaultFeed: feed === 'foryou' || feed === 'latest' || feed === 'following' ? feed : DEFAULT_PREFS.defaultFeed,
    autoplay: typeof r.autoplay === 'boolean' ? r.autoplay : DEFAULT_PREFS.autoplay,
    oneClick: typeof r.oneClick === 'boolean' ? r.oneClick : DEFAULT_PREFS.oneClick,
    oneClickLimit: (ONE_CLICK_LIMITS as readonly unknown[]).includes(limit)
      ? (limit as OneClickLimit)
      : DEFAULT_PREFS.oneClickLimit,
    quickTip: typeof tip === 'number' && Number.isFinite(tip) && tip >= 1 ? Math.floor(tip) : DEFAULT_PREFS.quickTip,
    paidLikeSats:
      typeof r.paidLikeSats === 'number' && Number.isSafeInteger(r.paidLikeSats) && r.paidLikeSats >= 546
        ? r.paidLikeSats
        : DEFAULT_PREFS.paidLikeSats,
    indexAutoPayUsd: (INDEX_AUTOPAY_USD as readonly unknown[]).includes(r.indexAutoPayUsd)
      ? (r.indexAutoPayUsd as IndexAutoPayUsd)
      : DEFAULT_PREFS.indexAutoPayUsd,
    animatedBackgrounds:
      typeof r.animatedBackgrounds === 'boolean' ? r.animatedBackgrounds : DEFAULT_PREFS.animatedBackgrounds,
    notify: parseNotify(r.notify),
    twetchUserId:
      typeof r.twetchUserId === 'string' && /^\d{1,12}$/.test(r.twetchUserId.trim()) ? r.twetchUserId.trim() : '',
    filterStrong: r.filterStrong === true,
    sounds: r.sounds !== false,
    // A stored allowLanguageReveal (the retired 18+ opt-in) is dropped here: slurs are blurred per post now.
  };
};

export const loadPrefs = (): Prefs => {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const savePrefs = (patch: Partial<Prefs>): Prefs => {
  const next = parsePrefs({ ...loadPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // storage unavailable
  }
  return next;
};

export const onPrefsChange = (fn: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** The tab and sort the Feed opens to. */
export const initialFeed = (
  pref: DefaultFeed,
  followsSomeone: boolean,
): { tab: 'foryou' | 'following'; sort: 'latest' | 'locked' } => {
  if (pref === 'foryou') return { tab: 'foryou', sort: 'locked' };
  if (pref === 'following' && followsSomeone) return { tab: 'following', sort: 'latest' };
  return { tab: 'foryou', sort: 'latest' };
};
