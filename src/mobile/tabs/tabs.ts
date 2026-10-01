import type { MenuItems } from '../../contexts/BottomMenuContext';

/**
 * Mobile tab ids. Upstream's MenuItems plus the mobile-only Media and Market
 * tabs; the swapped useBottomMenu/BottomMenu understand all of them.
 * Upstream ids keep working: 'ords' opens Media, 'tools' opens Settings › Tools.
 * Settings is not on the bar; it opens from the account drawer (TopNav).
 */
export type MobileTab = MenuItems | 'media' | 'market' | 'chat';

export const asMenuItem = (tab: MobileTab) => tab as MenuItems;

/** Which bottom-bar tab is lit for a selected id. */
export const tabFor = (selected: string | null): MobileTab => {
  switch (selected) {
    case 'ords':
    case 'media':
      return 'media';
    case 'tools':
    case 'settings':
      return 'settings';
    case 'market':
    case 'browser':
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
      return '/bsv-wallet';
    case 'ords':
    case 'media':
      return '/m/media';
    case 'market':
      return '/m/market';
    case 'browser':
      return '/browser';
    case 'chat':
      return '/m/chat';
    case 'settings':
    case 'tools':
      return '/m/settings';
    default:
      return null;
  }
};
