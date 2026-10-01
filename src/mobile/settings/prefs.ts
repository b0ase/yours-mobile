/**
 * bWallet app preferences (Feed / Payments / Media). Device-wide localStorage, like the rest of the feed
 * state (follows, mutes, likes): these are UI choices, not keys or balances.
 *
 * Default feed mapping (what the Feed tab opens to):
 *   - 'following' → Following tab; falls back to Latest when you follow nobody (the old behaviour, and the default)
 *   - 'latest'    → For you tab, sorted by newest
 *   - 'foryou'    → For you tab, ranked by BSV locked behind each post
 */
export type DefaultFeed = 'foryou' | 'latest' | 'following';
export const ONE_CLICK_LIMITS = [100, 1_000, 10_000] as const;
export type OneClickLimit = (typeof ONE_CLICK_LIMITS)[number];
export const INDEX_AUTOPAY_USD = [0, 0.05, 0.1, 0.25] as const;
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
  /**
   * Indexing fees for your own tokens under this many USD pay on one tap (no confirm sheet).
   * 0 = always confirm. Guarded like one-click pay (src/mobile/tokens/indexAutoPay.ts).
   */
  indexAutoPayUsd: IndexAutoPayUsd;
  /** Looping video behind Apps, Wallet and Feed. Off: still image only. */
  animatedBackgrounds: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  defaultFeed: 'following',
  autoplay: false,
  oneClick: false,
  oneClickLimit: 1_000,
  quickTip: 1_000,
  animatedBackgrounds: true,
  indexAutoPayUsd: 0.1,
};

const KEY = 'bwallet.prefs';
const EVENT = 'bwallet-prefs';

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
    indexAutoPayUsd: (INDEX_AUTOPAY_USD as readonly unknown[]).includes(r.indexAutoPayUsd)
      ? (r.indexAutoPayUsd as IndexAutoPayUsd)
      : DEFAULT_PREFS.indexAutoPayUsd,
    animatedBackgrounds:
      typeof r.animatedBackgrounds === 'boolean' ? r.animatedBackgrounds : DEFAULT_PREFS.animatedBackgrounds,
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
