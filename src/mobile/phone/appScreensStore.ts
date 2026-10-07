import { useSyncExternalStore } from 'react';
import { MARKET_ENABLED } from '../storeBuild';
import {
  APP_SCREENS_KEY,
  defaultScreens,
  parseScreens,
  reconcile,
  serialiseScreens,
  type AppScreensState,
} from './appScreens';
import { dockSubscribe, getDock } from './dockStore';
import type { DockItem } from './dockModel';

/**
 * The app screens, saved per device (appScreens.ts APP_SCREENS_KEY), reconciled with the dock on every read:
 * a tile is in the dock or on a screen, never both, and Wallet (and the other page tiles) are never lost.
 * The first layout needs the app catalogue, which BrowserPage registers (setDefaultBuilder) when it loads.
 */
export const dockKeyOf = (i: DockItem) => (i.kind === 'app' ? i.url : i.kind === 'screen' ? `screen:${i.id}` : '');

/** Page tiles every layout must keep reachable, Wallet first. */
export const REQUIRED_TILES = [
  'screen:wallet',
  ...(MARKET_ENABLED ? ['screen:exchange'] : []),
  'screen:feed',
  'screen:chat',
];

let builder: (() => AppScreensState) | null = null;
let saved: AppScreensState | null | undefined;
let cache: { dock: DockItem[]; base: AppScreensState | null; value: AppScreensState } | null = null;
const listeners = new Set<() => void>();
const PLACEHOLDER: AppScreensState = defaultScreens([], [], []);

const readSaved = (): AppScreensState | null => {
  if (saved !== undefined) return saved;
  try {
    saved = parseScreens(localStorage.getItem(APP_SCREENS_KEY));
  } catch {
    saved = null;
  }
  return saved;
};

const read = (): AppScreensState => {
  const dock = getDock();
  const base = readSaved() ?? (builder ? builder() : null);
  if (cache && cache.dock === dock && cache.base === base) return cache.value;
  if (base && !saved) saved = base; // the built default is the starting point from now on
  const value = reconcile(base ?? PLACEHOLDER, new Set(dock.map(dockKeyOf).filter(Boolean)), REQUIRED_TILES);
  cache = { dock, base, value };
  return value;
};

const notify = () => listeners.forEach((l) => l());

export const setDefaultBuilder = (fn: () => AppScreensState) => {
  if (builder) return;
  builder = fn;
  notify();
};

export const getAppScreens = () => read();

export const setAppScreens = (next: AppScreensState) => {
  saved = next;
  try {
    localStorage.setItem(APP_SCREENS_KEY, serialiseScreens(next));
  } catch {
    /* storage unavailable: kept for this session only */
  }
  notify();
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  const off = dockSubscribe(fn);
  return () => {
    listeners.delete(fn);
    off();
  };
};

export const useAppScreens = (): AppScreensState => useSyncExternalStore(subscribe, read, read);
