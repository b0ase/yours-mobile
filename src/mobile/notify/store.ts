/**
 * Notification list + poll state, persisted in localStorage (device-wide, like the feed state).
 * Subscribable so the bell badge and list update live.
 */
import { addItems, markAllRead, markRead, type NotifyItem } from './notify';

const ITEMS = 'bwallet.notify.items';
const STATE = 'bwallet.notify.state';
const ASKED = 'bwallet.notify.asked';

/** Per-source cursors: seen ids, counters and whether the source has had its silent first run. */
export type PollState = {
  seen: Record<string, string[]>;
  counts: Record<string, Record<string, number>>;
  seeded: Record<string, boolean>;
  /** Our listings (outpoint → price sats) last time we looked. */
  listings: Record<string, number>;
};

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

let items: NotifyItem[] = read<NotifyItem[]>(ITEMS, []).filter((i) => i && typeof i.id === 'string');
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getItems = () => items;
export const subscribeItems = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const setItems = (next: NotifyItem[]) => {
  if (next === items) return;
  items = next;
  write(ITEMS, items);
  emit();
};

/** Adds items; returns the ones that were new. */
export const pushItems = (incoming: NotifyItem[]): NotifyItem[] => {
  if (!incoming.length) return [];
  const { list, added } = addItems(items, incoming);
  if (added.length) setItems(list);
  return added;
};
export const readAll = () => setItems(markAllRead(items));
export const readOne = (id: string) => setItems(markRead(items, id));
export const clearItems = () => setItems([]);

export const loadPollState = (): PollState => {
  const s = read<Partial<PollState>>(STATE, {});
  return { seen: s.seen ?? {}, counts: s.counts ?? {}, seeded: s.seeded ?? {}, listings: s.listings ?? {} };
};
export const savePollState = (s: PollState) => write(STATE, s);

export const wasAsked = () => read<boolean>(ASKED, false);
export const setAsked = () => write(ASKED, true);
