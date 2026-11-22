/**
 * Tokens with no curve buy/sell in the wallet (UI layer only; the launchpad money paths are untouched).
 * TokenBlaster marks these with `trading: false` (and an `earn_url`) on /api/launch/coins and /api/launch/coin;
 * until that ships, NO_CURVE_IDS is the fallback. Holders still send these person to person.
 */
// The arcade's address, its token and the line about it are bWalletX only: not in a store bundle even as data (the
// same literal env check as storeBuild.ts TOKENBLASTER_ENABLED).
const ARCADE: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
export const TERRORNODE_GAME_URL = ARCADE ? 'https://www.tokenblaster.lol/arcade/terrornode' : '';

/** $TERRORNODE: earned by playing Assault on Terrornode (owner, 25 Oct 2026). */
export const NO_CURVE_IDS: Readonly<Record<string, string>> = ARCADE
  ? {
      d5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1: TERRORNODE_GAME_URL,
    }
  : {};

export const NO_CURVE_LINE = ARCADE ? 'Earned by playing; trade person to person' : '';

type CoinFlags = { token_id?: unknown; trading?: unknown; earn_url?: unknown };

/** Only https links on www.tokenblaster.lol are followed. */
export const safeEarnUrl = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'www.tokenblaster.lol' ? u.href : null;
  } catch {
    return null;
  }
};

/** True when the wallet must not offer curve buy/sell for this token. */
export const isNoCurve = (id: string, coin?: CoinFlags | null): boolean =>
  coin?.trading === false || Object.prototype.hasOwnProperty.call(NO_CURVE_IDS, id);

/** Where "Earn" goes for a no-curve token, or null. */
export const earnUrl = (id: string, coin?: CoinFlags | null): string | null =>
  safeEarnUrl(coin?.earn_url) ?? (Object.prototype.hasOwnProperty.call(NO_CURVE_IDS, id) ? NO_CURVE_IDS[id] : null);
