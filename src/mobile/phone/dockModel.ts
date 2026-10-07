import { moveItem } from '../reorder';
import { STORE_BUILD, dockItemsFor } from '../storeBuild';
import { SCREENS, type ScreenId } from './screens';

/**
 * The phone layout's dock (docs/PHONE-LAYOUT-PLAN.md §5, §14). Pure state helpers, unit-tested.
 * The b button is not an item: it always sits in the middle of the dock. Wallet is the leftmost slot by default,
 * like the iPhone's Phone app (the safeguard: Send/Receive is on the Wallet page). An empty dock is allowed.
 */
export type DockAction = 'sendReceive';
export type DockItem =
  | { kind: 'screen'; id: ScreenId }
  | { kind: 'action'; id: DockAction }
  | { kind: 'app'; url: string; name: string; icon?: string };
export type DockState = { v: 1; items: DockItem[] };

/** Like the iPhone: four slots plus the fixed centre b (owner, round 4). */
export const DOCK_MAX = 4;
/**
 * A dock saved before the 4-slot limit may hold more (up to the old 12): it is kept as the user left it (never
 * trimmed, so nothing is lost); adding is refused until it is under DOCK_MAX.
 */
export const DOCK_LOAD_MAX = 12;
/** Slots left of the b. The rest sit right of it and scroll. */
export const DOCK_LEFT = 2;
export const DOCK_KEY = 'bwallet:dock:v1';

/**
 * Default dock (owner, 7 Oct 2026 feedback): Wallet · Exchange · ( b ) · Feed · Chat. Send/Receive lives on the
 * Wallet page, so Exchange takes its slot. A store build has no Exchange: Apps takes the slot instead.
 */
export const defaultDock = (store = STORE_BUILD): DockItem[] => [
  { kind: 'screen', id: 'wallet' },
  { kind: 'screen', id: store ? 'apps' : 'exchange' },
  { kind: 'screen', id: 'feed' },
  { kind: 'screen', id: 'chat' },
];
export const DEFAULT_DOCK: readonly DockItem[] = defaultDock();

/** The first default (5.1.8x previews): a saved dock exactly equal to it is moved to the new default. */
export const OLD_DEFAULT_DOCK: readonly DockItem[] = [
  { kind: 'screen', id: 'wallet' },
  { kind: 'action', id: 'sendReceive' },
  { kind: 'screen', id: 'chat' },
  { kind: 'screen', id: 'feed' },
];

const isOldDefault = (items: readonly DockItem[]) =>
  items.length === OLD_DEFAULT_DOCK.length && items.every((i, n) => sameItem(i, OLD_DEFAULT_DOCK[n]));

const ACTIONS: readonly DockAction[] = ['sendReceive'];
const SCREEN_IDS = new Set<string>(SCREENS.map((s) => s.id));

export const dockKey = (i: DockItem) => (i.kind === 'app' ? `app:${i.url}` : `${i.kind}:${i.id}`);
export const sameItem = (a: DockItem, b: DockItem) => dockKey(a) === dockKey(b);

const valid = (x: unknown): x is DockItem => {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === 'screen') return typeof o.id === 'string' && SCREEN_IDS.has(o.id);
  if (o.kind === 'action') return typeof o.id === 'string' && (ACTIONS as readonly string[]).includes(o.id);
  if (o.kind === 'app') return typeof o.url === 'string' && /^https?:\/\//.test(o.url) && typeof o.name === 'string';
  return false;
};

/** Clean a list: unknown and duplicate items dropped, store-disallowed items dropped, capped at DOCK_LOAD_MAX. */
export const cleanDock = (items: readonly unknown[], store = STORE_BUILD): DockItem[] => {
  const seen = new Set<string>();
  const out: DockItem[] = [];
  for (const x of items) {
    if (!valid(x)) continue;
    const item: DockItem =
      x.kind === 'app'
        ? { kind: 'app', url: x.url, name: x.name, icon: typeof x.icon === 'string' ? x.icon : undefined }
        : x;
    const k = dockKey(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return dockItemsFor(out, store).slice(0, DOCK_LOAD_MAX);
};

/**
 * Saved JSON → the dock. Missing or corrupt → the default; a saved empty dock stays empty. A saved dock that is
 * exactly the old default (never customised) becomes the new default; any other saved dock is left alone.
 */
export const normaliseDock = (raw: string | null, store = STORE_BUILD): DockItem[] => {
  const fallback = () => cleanDock(defaultDock(store), store);
  if (raw == null) return fallback();
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = (parsed as Partial<DockState> | null)?.items;
    if (!parsed || (parsed as DockState).v !== 1 || !Array.isArray(items)) return fallback();
    const clean = cleanDock(items, store);
    if (isOldDefault(clean) && clean.length === items.length) return fallback();
    return clean;
  } catch {
    return fallback();
  }
};

export const serialiseDock = (items: readonly DockItem[]): string =>
  JSON.stringify({ v: 1, items: [...items] } satisfies DockState);

export type AddResult =
  | { items: DockItem[]; ok: true }
  | { items: DockItem[]; ok: false; reason: 'full' | 'already' | 'blocked' };

export const addToDock = (items: readonly DockItem[], item: DockItem, store = STORE_BUILD): AddResult => {
  if (items.some((i) => sameItem(i, item))) return { items: [...items], ok: false, reason: 'already' };
  if (!cleanDock([item], store).length) return { items: [...items], ok: false, reason: 'blocked' };
  if (items.length >= DOCK_MAX) return { items: [...items], ok: false, reason: 'full' };
  return { items: [...items, item], ok: true };
};

export const removeFromDock = (items: readonly DockItem[], item: DockItem): DockItem[] =>
  items.filter((i) => !sameItem(i, item));

export const moveInDock = (items: readonly DockItem[], from: number, to: number): DockItem[] =>
  moveItem(items, from, to);

/** Screens and actions not in the dock yet (the Add sheet). */
export const addable = (items: readonly DockItem[], screens: readonly { id: ScreenId }[]): DockItem[] =>
  [
    ...ACTIONS.map((id): DockItem => ({ kind: 'action', id })),
    ...screens.map((s): DockItem => ({ kind: 'screen', id: s.id })),
  ].filter((c) => !items.some((i) => sameItem(i, c)));

/**
 * iPhone model (owner, round 4): Wallet, Exchange, Feed, Chat (and Apps in a store build) are ordinary Home
 * tiles that sit in the dock by default. Each is shown in exactly one place: the dock, or the Home grid. So
 * Wallet is never lost: off the dock it is a Home tile.
 */
export const HOME_SCREEN_IDS: readonly ScreenId[] = ['wallet', 'exchange', 'apps', 'feed', 'chat'];

/** The screen tiles the Home grid shows: those not in the dock, for this build's strip. Wallet first. */
export const homeScreenTiles = (items: readonly DockItem[], strip: readonly { id: ScreenId }[]): ScreenId[] =>
  HOME_SCREEN_IDS.filter(
    (id) => strip.some((s) => s.id === id) && !items.some((i) => i.kind === 'screen' && i.id === id),
  ).filter((id) => id !== 'apps' || !strip.some((s) => s.id === 'exchange'));

/** App URLs in the dock: the Home grid leaves them out. */
export const dockAppUrls = (items: readonly DockItem[]): Set<string> =>
  new Set(items.flatMap((i) => (i.kind === 'app' ? [i.url] : [])));

/** Split for the layout: the first DOCK_LEFT slots sit left of the b, the rest right of it (scrolling). */
export const splitDock = <T>(items: readonly T[]): { left: T[]; right: T[] } => ({
  left: items.slice(0, DOCK_LEFT),
  right: items.slice(DOCK_LEFT),
});
