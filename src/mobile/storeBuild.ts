/**
 * Store build switch. `pnpm build:mobile:store` (VITE_STORE_BUILD=1) builds the variant shipped through
 * the App Store / Google Play; the default build (direct download / APK) is unchanged. The ios-store and
 * android-play channels (channel.ts) turn it on too.
 *
 * In a store build the wallet never asks the user to pay bCorp to unlock app features, and holding a
 * token never unlocks app functionality (Apple 3.1.1 / 3.1.5, Google Play Payments policy). See
 * docs/STORE-AUDIT.md. Peer-to-peer send / receive, tips and viewing NFTs stay on.
 *
 * Every gate is here so the list of what changes is in one place. Helpers take the flag as a
 * parameter (default STORE_BUILD) so they are unit-tested both ways (storeBuild.test.ts).
 * `import.meta.env.VITE_STORE_BUILD` is written literally so Vite inlines it and Rollup drops the
 * dead branches (the paid b agent endpoints are not in the store bundle).
 */
export const STORE_BUILD: boolean =
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play';

/** b agent: own-key mode only in a store build (no pay-per-message to bCorp). */
export const agentModeFor = <M extends string>(mode: M, store = STORE_BUILD): M | 'own' => (store ? 'own' : mode);

/** Shown in Settings › b agent in place of the mode / daily-limit pickers. */
export const STORE_AGENT_NOTE = 'Use your own AI provider key';

/** Fee addresses that pay bCorp (Mint, Market, ticket resale): none in a store build. */
export const bcorpFeeAddress = (address: string, store = STORE_BUILD): string => (store ? '' : address);

/** Wallet tab switch: no Tickets (token-gated rooms) or Credits (prepaid bCorp credits) in a store build. */
export const STORE_HIDDEN_WALLET_KINDS: readonly string[] = ['tickets', 'credits'];
export const walletKindsFor = <T extends readonly [string, ...unknown[]]>(
  kinds: readonly T[],
  store = STORE_BUILD,
): T[] => (store ? kinds.filter((k) => !STORE_HIDDEN_WALLET_KINDS.includes(k[0])) : [...kinds]);

/**
 * Market Tokens sub-filters: no Tickets (room access) in a store build (curve coins: CURVE_COINS_ENABLED). bApps is a plain token filter.
 */
export const STORE_HIDDEN_MARKET_FILTERS: readonly string[] = ['tickets'];
export const marketFiltersFor = <T extends readonly [string, ...unknown[]]>(
  filters: readonly T[],
  store = STORE_BUILD,
): T[] => (store ? filters.filter((f) => !STORE_HIDDEN_MARKET_FILTERS.includes(f[0])) : [...filters]);

/**
 * Market buy / sell / list: off in a store build, where the Market is view-only. App Review rejected
 * build 8 under 3.1.5(iii) (exchange functionality needs a licensed exchange); bWalletX keeps trading.
 */
export const marketTradingEnabled = (store = STORE_BUILD) => !store;

/**
 * Bonding-curve coin trading (Market › Tokens, market/launchpad/): never in a store build, not even as
 * code. A literal env check so Vite inlines it and Rollup drops the lazy import in MarketPage.tsx.
 */
export const CURVE_COINS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/** Token-gated chatrooms open (join / start / buy-to-join) only outside a store build. */
export const tokenRoomsEnabled = (store = STORE_BUILD) => !store;
export const STORE_ROOM_NOTE = 'Token rooms aren’t available in this version of bWallet.';

/** Wallet › Mint choices: tokens and media in a store build (no bCorp fee); no chatroom tickets. */
export type MintChoice = 'ticket' | 'token' | 'media';
export const mintChoicesFor = (store = STORE_BUILD): MintChoice[] =>
  store ? ['token', 'media'] : ['ticket', 'token', 'media'];

/** Token indexing fee: paid to the third-party 1Sat overlay (a network cost, like gas), so on everywhere. */
export const indexingEnabled = (_store = STORE_BUILD) => true;

/** Paid features shown outside a store build only: Credits, paid indexing, personal token + room. */
export const paidFeaturesEnabled = (store = STORE_BUILD) => !store;

/** bWalletX = every non-store build (private channels, web, dev); the store app is plain bWallet. */
export const isBWalletX = (store = STORE_BUILD) => !store;
export const appNameFor = (store = STORE_BUILD) => (store ? 'bWallet' : 'bWalletX');

/** The trading tab: "Exchange" in bWalletX (it trades, hence the X), "Market" in the store app (browse only). */
export const marketLabel = (store = STORE_BUILD) => (store ? 'Market' : 'Exchange');

/**
 * "Continue with X / Google" on Create Account: bWalletX only for now. App Review guideline 4.8
 * (offer Sign in with Apple beside a third-party login) may apply; switch on once that's settled.
 */
export const socialLoginEnabled = (store = STORE_BUILD) => !store;

/**
 * Buying crypto: the Buy BSV card / sheet (ChangeNOW, Alchemy Pay, Ramp later), "Get BSV" on an empty wallet and
 * "Get MNEE" (MNEE's referral sign-up). All lead to third-party on-ramps / exchanges, so bWalletX only: the store
 * edition has no buying or exchange (Play financial features declaration: none).
 */
export const buyCryptoEnabled = (store = STORE_BUILD) => !store;

/** The app's own name for user-visible text: "bWallet" in a store build, "bWalletX" otherwise. */
export const APP_NAME = appNameFor();

/**
 * The same gates as plain constants, for JSX: Rollup folds `!STORE_BUILD` at build time, so the store bundle
 * doesn't even contain the hidden screens' text (a function call isn't folded).
 */
export const BUY_CRYPTO_ENABLED: boolean = !STORE_BUILD;
export const PAID_FEATURES_ENABLED: boolean = !STORE_BUILD;

/**
 * Feed bad language (feed/language.ts). Store edition: slurs hidden with no reveal and swearing always
 * blurred behind "Show anyway"; the two Settings toggles are not shown. bWalletX: swearing shown unless
 * "Filter strong language" is on; slur posts hidden, revealable only after the adult opt-in.
 */
export const languageSettingsEnabled = (store = STORE_BUILD) => !store;
export const languageOptsFor = (
  prefs: { filterStrong: boolean; allowLanguageReveal: boolean },
  store = STORE_BUILD,
): { store: boolean; filterStrong: boolean; allowReveal: boolean } => ({
  store,
  filterStrong: store || prefs.filterStrong,
  allowReveal: !store && prefs.allowLanguageReveal,
});
