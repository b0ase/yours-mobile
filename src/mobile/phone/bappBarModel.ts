import { BMINT_NOTES_ENABLED, MARKET_ENABLED } from '../storeBuild';

/**
 * The five-button bApp bar (docs/BAPP-SHELL.md on docs/bapp-shell; owner, 8 Oct 2026). Pure: no React, unit-tested.
 *
 * Every bApp with a real screen in the wallet gets the wallet's own five slots, scoped to the app:
 *   Wallet · Exchange · (b) · Feed · Chat
 * with ☰ (the wallet menu) and the app's icon top-left; the icon opens the app's Home and its sections. A slot the
 * app has no real screen for is greyed out, never hidden and never faked. The centre b is always real (b, with
 * hold-to-talk, same as the wallet's dock).
 *
 * Brought over from the Desktop prototype (wide/BappHost.tsx: a bApp's sections column). bChatX is not listed: it
 * keeps its own bar. Feed and Exchange are wallet pages, already on the wallet's dock.
 */
export type BarSlot = 'wallet' | 'exchange' | 'feed' | 'chat';
export const BAR_SLOTS: readonly BarSlot[] = ['wallet', 'exchange', 'feed', 'chat'];
export const SLOT_LABELS: Record<BarSlot, string> = {
  wallet: 'Wallet',
  exchange: 'Exchange',
  feed: 'Feed',
  chat: 'Chat',
};

export type BappSection = { label: string; route: string };

export type BappBarDef = {
  id: string;
  name: string;
  /** Path prefix that is this bApp (/m/bmail matches /m/bmail and /m/bmail/…, not /m/bmailer). */
  prefix: string;
  /** Other prefixes that also belong to it. */
  also?: readonly string[];
  /** The bApp icon slug (brand/bappIcons: follows the theme pack; no glyph = the gold initial). */
  icon: string;
  home: string;
  /** Real in-app routes per slot; a missing slot is greyed out. */
  slots: Partial<Record<BarSlot, string>>;
  /** The app's Home and secondary sections, opened from its icon top-left. */
  sections: readonly BappSection[];
};

export const BAPP_BARS: readonly BappBarDef[] = [
  {
    id: 'bmail',
    name: 'bMail',
    prefix: '/m/bmail',
    icon: 'bmail',
    home: '/m/bmail',
    // bMail is one mailbox: no holdings, market, feed or rooms of its own yet.
    slots: {},
    sections: [
      { label: 'Inbox', route: '/m/bmail' },
      { label: 'Requests', route: '/m/bmail?tab=requests' },
      { label: 'Quarantine', route: '/m/bmail?tab=quarantine' },
      { label: 'Bin', route: '/m/bmail?tab=bin' },
    ],
  },
  {
    id: 'bmint',
    name: 'bMint',
    prefix: '/m/bmint',
    also: ['/m/names'],
    icon: 'bmint',
    home: '/m/bmint',
    // The Name Store is where names are bought: bMint's market. Store builds have no Market at all.
    slots: MARKET_ENABLED ? { exchange: '/m/names' } : {},
    sections: [
      { label: 'Mint', route: '/m/bmint' },
      { label: 'Get a name', route: '/m/names' },
      ...(BMINT_NOTES_ENABLED ? [{ label: 'Notes', route: '/m/bmint/notes' }] : []),
    ],
  },
  {
    id: 'bmusic',
    name: 'bMusic',
    prefix: '/m/media',
    icon: 'bmusic',
    home: '/m/media',
    // Browse is the music store.
    slots: { exchange: '/m/media/browse' },
    sections: [
      { label: 'Home', route: '/m/media' },
      { label: 'Browse', route: '/m/media/browse' },
      { label: 'Artists', route: '/m/media/artists' },
    ],
  },
  {
    id: 'bpics',
    name: 'bPics',
    prefix: '/m/bpics',
    icon: 'bphotos',
    home: '/m/bpics',
    // On chain · Library · Mine are tabs inside the page, not routes yet.
    slots: {},
    sections: [{ label: 'Home', route: '/m/bpics' }],
  },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/');

/** The bApp a path belongs to, or null (wallet pages, bChatX, onboarding…). */
export const bappBarForPath = (pathname: string, bars: readonly BappBarDef[] = BAPP_BARS): BappBarDef | null => {
  const path = pathname.replace(/\/+$/, '') || '/';
  return bars.find((b) => under(path, b.prefix) || (b.also ?? []).some((p) => under(path, p))) ?? null;
};

export type BarButton = { slot: BarSlot; label: string; route: string | null; active: boolean };

/** The four side buttons (b sits in the middle): greyed (route null) where the app has no real screen. */
export const barButtons = (def: BappBarDef, pathname: string, search = ''): BarButton[] => {
  const here = pathname + search;
  return BAR_SLOTS.map((slot) => {
    const route = def.slots[slot] ?? null;
    const base = route?.split('?')[0] ?? null;
    return { slot, label: SLOT_LABELS[slot], route, active: !!route && (here === route || pathname === base) };
  });
};

/** The phone top bar's fixed buttons, left to right (TopNav.tsx). bMail is the mailbox button. */
export const TOP_BAR_FIXED = ['accounts', 'calls', 'bmail', 'media', 'lock'] as const;

/**
 * The bApp button the phone top bar adds after Calls on this path, or null. A bApp that already has a fixed
 * button (bMail = the mailbox) gets none: that button is highlighted instead, so opening bMail never shows
 * a second bMail icon (owner, 19 Oct 2026).
 */
export const topBarBappForPath = (pathname: string, bars: readonly BappBarDef[] = BAPP_BARS): BappBarDef | null => {
  const def = bappBarForPath(pathname, bars);
  return def && !(TOP_BAR_FIXED as readonly string[]).includes(def.id) ? def : null;
};

/** Slot ids the phone top bar renders on this path, in order. */
export const topBarSlots = (pathname: string, bars: readonly BappBarDef[] = BAPP_BARS): string[] => {
  const extra = topBarBappForPath(pathname, bars);
  const [accounts, calls, ...rest] = TOP_BAR_FIXED;
  return [accounts, calls, ...(extra ? [extra.id] : []), ...rest];
};
