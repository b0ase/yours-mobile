import { useSyncExternalStore } from 'react';
import { DOCK_KEY, normaliseDock, serialiseDock, type DockItem } from './dockModel';

/** The dock, saved per device in localStorage (dockModel.ts DOCK_KEY), with a hook. Same try/catch style as Apps favourites. */
let cache: DockItem[] | null = null;
const listeners = new Set<() => void>();

const read = (): DockItem[] => {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DOCK_KEY);
  } catch {
    raw = null;
  }
  cache = normaliseDock(raw);
  return cache;
};

export const getDock = () => read();

export const setDock = (items: DockItem[]) => {
  cache = items;
  try {
    localStorage.setItem(DOCK_KEY, serialiseDock(items));
  } catch {
    /* storage unavailable: kept for this session only */
  }
  listeners.forEach((l) => l());
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useDock = (): [DockItem[], (items: DockItem[]) => void] => [
  useSyncExternalStore(subscribe, read, read),
  setDock,
];
