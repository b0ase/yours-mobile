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

/**
 * Everything tokenblaster.lol (the TokenBlaster owner tile, Home addition, and the 1Sat Ordnance 3D
 * catalogue with its "buy it there" link): bWalletX only, absent from a store build even as data
 * (outside purchase of digital goods: Apple 3.1.1, Play Payments). Literal env check so Vite inlines
 * it and Rollup drops the data and the lazy imports. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const TOKENBLASTER_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * Owner apps left out of a store build: TokenBlaster sells guns and runs a coin launchpad, so a store
 * app linking to it would point users at outside buying (Apple 3.1.1/3.1.5, Play Payments).
 */
// Folds to [] in a store build, where the tile's data is not in the bundle at all (TOKENBLASTER_ENABLED).
export const STORE_HIDDEN_OWNER_APPS: readonly string[] = TOKENBLASTER_ENABLED ? ['TokenBlaster'] : [];
export const ownerAppsFor = <T extends { name: string }>(apps: readonly T[], store = STORE_BUILD): T[] =>
  store ? apps.filter((a) => !STORE_HIDDEN_OWNER_APPS.includes(a.name)) : [...apps];

/**
 * The Market / Exchange tab and everything that leads to it (Buy / Get PNEEs / Back PNEEs buttons, token pages'
 * Buy, the Apps tiles for exchanges, swaps, marketplaces and BSV on-ramps): bWalletX only. App Review rejected
 * the iOS store build under 3.1.5(iii) (exchange functionality without licences, plus EEA / MiCA), so the store
 * edition has no Market at all, not even view-only. Literal env check so Vite inlines it and Rollup drops the
 * MarketPage chunk and the gated buttons and data. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const MARKET_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
/**
 * Apps tiles left out of a store build: exchanges / swaps (bApps by name, BSVRadar groups by id). The data
 * itself is gated by MARKET_ENABLED in bapps.ts / radarApps.ts, so the name folds to [] in a store build.
 */
export const STORE_HIDDEN_APPS: readonly string[] = MARKET_ENABLED ? ['bExchange'] : [];
export const STORE_HIDDEN_RADAR_GROUPS: readonly string[] = ['market', 'buy'];
export const appsTileShown = (name: string, store = STORE_BUILD) => !store || !STORE_HIDDEN_APPS.includes(name);
export const radarGroupShown = (group: string, store = STORE_BUILD) =>
  !store || !STORE_HIDDEN_RADAR_GROUPS.includes(group);

/** Token-gated chatrooms open (join / start / buy-to-join) only outside a store build. */
export const tokenRoomsEnabled = (store = STORE_BUILD) => !store;
export const STORE_ROOM_NOTE = 'Token rooms aren’t available in this version of bWallet.';

/**
 * bSpaces (docs/BSPACES-PLAN.md): live audio/video spaces inside token rooms, bWalletX only. Spaces
 * live in token rooms, which a store build does not have, and live video to an audience needs
 * Apple 1.2 / Play UGC moderation plus the paid-ticket decision first. Literal env check so Vite
 * inlines it and Rollup drops the lazy SpacesPage chunk and the in-room banner.
 */
export const BSPACES_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

/**
 * bPhone paid calls (docs/BPHONE-PLAN.md): charging to receive a call, the directory of people who
 * charge, and paying as you go. bWalletX only: the store edition keeps free voice and video calls
 * but never shows price setting or paid dialling (Apple 3.1.1 / 3.1.3(d) to be settled with a
 * reviewer first). Literal env check so Vite inlines it and Rollup drops the bPhone tab and the
 * pay loop from the store bundle. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const PAID_CALLS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const paidCallsEnabled = (store = STORE_BUILD) => !store;

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
 * Feed bad language (feed/language.ts). Store edition: slurs hidden with no reveal (names read "Hidden
 * name") and swearing always blurred behind "Show anyway"; the Settings toggle is not shown. bWalletX:
 * slur posts and names blurred behind a per-post "Show anyway" / tap; swearing shown unless "Filter
 * strong language" is on. A stored `allowLanguageReveal` (the retired 18+ opt-in) is ignored.
 */
export const languageSettingsEnabled = (store = STORE_BUILD) => !store;
export const languageOptsFor = (
  prefs: { filterStrong: boolean },
  store = STORE_BUILD,
): { store: boolean; filterStrong: boolean } => ({
  store,
  filterStrong: store || prefs.filterStrong,
});

/**
 * Pots and standing orders (docs/POTS-SUBSCRIPTIONS-PLAN.md §5). Pots (labelled sub-accounts: fund, name,
 * cap, Stop/Resume) and standing orders to a person or paymail are P2P transfers, so they are in every build.
 */
export const potsEnabled = (_store = STORE_BUILD) => true;
export const standingOrdersEnabled = (_store = STORE_BUILD) => true;

/**
 * Subscriptions to apps and services (the own-service payees: bChat, $b agent; later "Subscribe with
 * bWalletX" requests, the bridge method, link handler and merchant cards): bWalletX only, absent from a
 * store build even as code (Apple 3.1.1, Play Payments). Literal env check so Vite inlines it and Rollup
 * drops the dead branches. Same env as STORE_BUILD (storeBuild.test.ts).
 */
export const SUBSCRIPTIONS_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const subscriptionsEnabled = (store = STORE_BUILD) => !store;

/**
 * The bWalletX 1¢/day billing subscription: never in a store build. Outside one it still needs the signed
 * remote switch and the user's acceptance (config/remoteConfig.ts), and it is OFF today.
 */
export const BILLING_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const billingAllowed = (store = STORE_BUILD) => !store;

/**
 * User-visible text that differs in the store edition, which has no personal token / room, token rooms, paid
 * b agent or app/service subscriptions. Written as `STORE_BUILD ? … : …` on constants so Rollup folds them and
 * the bWalletX wording is not in the store bundle (storeBuild.test.ts checks both editions).
 */
export const handleCardText = (hasName: boolean): string =>
  STORE_BUILD
    ? 'A free handle people can pay.'
    : hasName
      ? 'Your personal token and a chat room only holders can enter.'
      : 'A free handle people can pay, plus your own chat room.';
export const MY_TOKENS_DESC = STORE_BUILD
  ? "Tokens this account has minted: list the ones that aren't listed yet"
  : "This account's tokens and their rooms: set up the ones that aren't listed yet";
export const MY_TOKENS_NOTE = STORE_BUILD
  ? 'Listing a token shows it in other wallets and the Market. You confirm the price before anything is sent.'
  : 'Setting up a token’s room lists it in other wallets and the Market and opens its chat room. You confirm the price before anything is sent.';
export const B_AGENT_DESC = STORE_BUILD ? 'Use your own AI key' : 'How the b agent is paid for';
export const SUBSCRIPTIONS_DESC = STORE_BUILD
  ? 'Regular payments to people, from pots you fill'
  : 'Regular payments from pots you fill';
export const POTS_INTRO = STORE_BUILD
  ? 'Put money aside in a pot and set up regular payments from it to a person or paymail. The pot balance is the most they can ever take. Payments go out when you open the app on or after each date; pause any time.'
  : 'Put money aside in a pot and set up subscriptions (regular payments) from it. The pot balance is the most they can ever take. Payments go out when you open the app on or after each date; pause any time.';
export const POT_NAME_PLACEHOLDER = STORE_BUILD ? 'Name (e.g. Rent, Savings)' : 'Name (e.g. Rent, bChat)';

/**
 * Phone layout (src/mobile/phone, docs/PHONE-LAYOUT-PLAN.md §8): swipe screens and dock items left out of a store
 * build. Exchange is the Market, which a store build does not have at all (MARKET_ENABLED above).
 */
export const STORE_HIDDEN_SCREENS: readonly string[] = ['exchange'];
export const screenShown = (id: string, store = STORE_BUILD) => !store || !STORE_HIDDEN_SCREENS.includes(id);
export const screensFor = <T extends { id: string }>(screens: readonly T[], store = STORE_BUILD): T[] =>
  screens.filter((s) => screenShown(s.id, store));
/** Dock items a store build may show: no hidden screens, and no app tile a store build hides (appsTileShown). */
export const dockItemsFor = <T extends { kind: string; id?: string; name?: string }>(
  items: readonly T[],
  store = STORE_BUILD,
): T[] =>
  items.filter((i) =>
    i.kind === 'screen' ? screenShown(i.id ?? '', store) : i.kind === 'app' ? appsTileShown(i.name ?? '', store) : true,
  );
/** Release B (People): no buying or selling a person's tokens or apps in a store build. */
export const peopleSellingEnabled = (store = STORE_BUILD) => !store;
