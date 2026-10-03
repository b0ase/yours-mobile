import type { MenuItems } from '../../contexts/BottomMenuContext';

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
export const TAB_ORDER: MobileTab[] = ['bsv', 'market', 'browser', 'feed', 'chat'];

export const asMenuItem = (tab: MobileTab) => tab as MenuItems;

/** Ids that open Wallet on its NFTs (media) view instead of Tokens. */
export const opensWalletNfts = (selected: string | null) => selected === 'ords';

/** Which bottom-bar tab is lit for a selected id. */
export const tabFor = (selected: string | null): MobileTab => {
  switch (selected) {
    case 'tools':
    case 'settings':
      return 'settings';
    case 'market':
    case 'browser':
    case 'feed':
    case 'chat':
      return selected;
    default:
      return 'bsv';
  }
};

/** Route for a selected id (mobile layout). */
export const routeFor = (selected: string | null): string | null => {
  switch (selected) {
    case 'bsv':
    case 'ords':
      return '/bsv-wallet';
    case 'media':
      return '/m/media';
    case 'market':
      return '/m/market';
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
