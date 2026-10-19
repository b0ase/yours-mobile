import { moveItem } from '../reorder';

/**
 * The wallet home as a desktop of modules (owner, 18 Oct 2026): each account keeps an ordered list of module ids in
 * localStorage. Pure helpers plus a tiny store; the registry (registry.tsx) says what each id renders.
 *
 * The card, when present, is always first: it carries the balance and sits right above Send / Receive.
 */
export const MODULE_IDS = [
  'card',
  'askB',
  'showcase',
  'history',
  'priceChart',
  'pots',
  'notifications',
  'music',
  'holdings',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Ask b last (owner, 19 Oct 2026: "a great helper, but not the primary feature on the wallet screen"). */
export const DEFAULT_LAYOUT: readonly ModuleId[] = ['card', 'showcase', 'askB'];
/** Phone/web's earlier untouched default: an account still on it moves to today's default. */
const OLD_DEFAULTS: readonly (readonly ModuleId[])[] = [['card', 'askB', 'showcase']];
/**
 * Desktop (wide) is the classic wallet again (owner, 19 Oct 2026): the card column with Send / Receive / Mint, and
 * the side pane right of it with the BSV price, History and Holdings. The top bar is the Ask b prompt and the beta
 * banner carries Swap / Buy, so the home opens with the card alone; Edit home still adds modules under it.
 */
export const WIDE_DEFAULT_LAYOUT: readonly ModuleId[] = ['card'];
/** Desktop's earlier untouched defaults (#283, #284): an account still on one of these moves to the new default. */
const OLD_WIDE_DEFAULTS: readonly (readonly ModuleId[])[] = [
  ['card', 'askB', 'showcase'],
  ['card', 'askB', 'holdings', 'showcase'],
];
/** The side pane already shows these on Desktop, so they are not home modules there. */
export const WIDE_PANE_MODULES: readonly ModuleId[] = ['holdings', 'history', 'priceChart'];

const same = (a: readonly ModuleId[], b: readonly ModuleId[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Desktop: an untouched old default becomes today's default; anything the user arranged is kept. */
export const migrateWide = (ids: readonly ModuleId[]): ModuleId[] =>
  OLD_WIDE_DEFAULTS.some((d) => same(d, ids)) ? [...WIDE_DEFAULT_LAYOUT] : [...ids];

/** Phone/web: an untouched old default becomes today's default (Ask b last); anything arranged is kept. */
export const migrateDefault = (ids: readonly ModuleId[]): ModuleId[] =>
  OLD_DEFAULTS.some((d) => same(d, ids)) ? [...DEFAULT_LAYOUT] : [...ids];

export const isModuleId = (v: unknown): v is ModuleId =>
  typeof v === 'string' && (MODULE_IDS as readonly string[]).includes(v);

/** Known ids only, no repeats, the card first. */
export const normalise = (ids: readonly unknown[]): ModuleId[] => {
  const out: ModuleId[] = [];
  for (const id of ids) if (isModuleId(id) && !out.includes(id)) out.push(id);
  const c = out.indexOf('card');
  if (c > 0) {
    out.splice(c, 1);
    out.unshift('card');
  }
  return out;
};

/**
 * Stored value → layout. Missing or unreadable: the defaults (this is also the migration for everyone who had the
 * wallet before modules: their home becomes the default desktop, with History one tap away as a module).
 * v0 was a bare array of ids; v1 is { v: 1, ids }.
 */
export const parseLayout = (
  raw: string | null | undefined,
  defaults: readonly ModuleId[] = DEFAULT_LAYOUT,
): ModuleId[] => {
  if (!raw) return [...defaults];
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return normalise(v);
    if (v && typeof v === 'object' && Array.isArray((v as { ids?: unknown }).ids))
      return normalise((v as { ids: unknown[] }).ids);
  } catch {
    /* fall through */
  }
  return [...defaults];
};

export const serialise = (ids: readonly ModuleId[]) => JSON.stringify({ v: 1, ids: normalise(ids) });

export const addModule = (ids: readonly ModuleId[], id: ModuleId): ModuleId[] =>
  ids.includes(id) ? [...ids] : normalise([...ids, id]);

export const removeModule = (ids: readonly ModuleId[], id: ModuleId): ModuleId[] => ids.filter((x) => x !== id);

/** Moves a module by `delta` places; the card never moves and nothing moves above it. */
export const shiftModule = (ids: readonly ModuleId[], id: ModuleId, delta: number): ModuleId[] => {
  const from = ids.indexOf(id);
  if (from < 0 || id === 'card') return [...ids];
  const floor = ids[0] === 'card' ? 1 : 0;
  const to = Math.max(floor, from + delta);
  return normalise(moveItem(ids, from, to));
};

/** Modules that may show in this build (`allowed`), in the user's order. */
export const visibleLayout = (ids: readonly ModuleId[], allowed: (id: ModuleId) => boolean): ModuleId[] =>
  ids.filter(allowed);

// ── Store (localStorage, per account) ──────────────────────────────────────────────────────────────────────────

const EVENT = 'bwallet:home-layout';
export const layoutKey = (account: string) => `bwallet.home.layout.${account || 'default'}`;

export const loadLayout = (
  account: string,
  defaults: readonly ModuleId[] = DEFAULT_LAYOUT,
  wide = false,
): ModuleId[] => {
  try {
    const ids = parseLayout(localStorage.getItem(layoutKey(account)), defaults);
    return wide ? migrateWide(ids) : migrateDefault(ids);
  } catch {
    return [...defaults];
  }
};

export const saveLayout = (account: string, ids: readonly ModuleId[]) => {
  try {
    localStorage.setItem(layoutKey(account), serialise(ids));
  } catch {
    /* storage unavailable: the change lasts this session */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const onLayoutChange = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
