import type { MenuItems } from '../../contexts/BottomMenuContext';
import { MARKET_ENABLED } from '../storeBuild';

/**
 * Mobile tab ids. Upstream's MenuItems plus the mobile-only Market, Feed and Chat tabs; the
 * swapped useBottomMenu/BottomMenu understand all of them.
 * Upstream ids keep working: 'ords' opens Wallet on its NFTs view, 'media' the Media page,
 * 'tools' opens Settings › Tools.
 * Settings is not on the bar; it opens from the account drawer (TopNav).
 */
export type MobileTab = MenuItems | 'market' | 'feed' | 'chat';

/** Window event fired on every bottom-bar tap (useBottomMenu routes it even if the tab is already selected). */
export const TAB_TAP = 'bwallet:tab-tap';

/** Bottom bar order, left to right: Wallet · Market · Apps · Feed · Chat (Wallet first and the default tab; Apps in the centre). */
// Store build: no Market tab at all (storeBuild.ts MARKET_ENABLED).
export const TAB_ORDER: MobileTab[] = MARKET_ENABLED
  ? ['bsv', 'market', 'browser', 'feed', 'chat']
  : ['bsv', 'browser', 'feed', 'chat'];

/**
 * The bar a visitor actually sees: no Exchange tab when the UK gate restricts them (region/region.ts, fail closed).
 * `market` is the effective gate (useMarketAllowed / marketAllowed), so a store build never has the tab either.
 */
export const visibleTabs = (market: boolean, order: readonly MobileTab[] = TAB_ORDER): MobileTab[] =>
  market ? [...order] : order.filter((t) => t !== 'market');

export const asMenuItem = (tab: MobileTab) => tab as MenuItems;

/** Ids that open Wallet on its NFTs (media) view instead of Tokens. */
export const opensWalletNfts = (selected: string | null) => selected === 'ords';

/** Which bottom-bar tab is lit for a selected id. */
export const tabFor = (selected: string | null, market: boolean = MARKET_ENABLED): MobileTab => {
  switch (selected) {
    case 'tools':
    case 'settings':
      return 'settings';
    case 'market':
      return market ? 'market' : 'bsv';
    case 'browser':
    case 'feed':
    case 'chat':
      return selected;
    default:
      return 'bsv';
  }
};

/** Route for a selected id (mobile layout). Pass the effective market gate where the UK gate applies. */
export const routeFor = (selected: string | null, market: boolean = MARKET_ENABLED): string | null => {
  switch (selected) {
    case 'bsv':
    case 'ords':
      return '/bsv-wallet';
    case 'media':
      return '/m/media';
    case 'market':
      return market ? '/m/exchange' : '/bsv-wallet';
    case 'browser':
      return '/browser';
    case 'feed':
      return '/m/feed';
    case 'chat':
      return '/m/chat';
    case 'settings':
    case 'tools':
      return '/m/settings';
    default:
      return null;
  }
};
