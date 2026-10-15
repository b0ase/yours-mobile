import { useSyncExternalStore } from 'react';

/**
 * Last-known balances per card id (owner, 15 Oct 2026: All cards shows each card's balance, live if cheap).
 * Screens that already hold a balance publish it here (no new polling, no network); cards read it. Only cards
 * marked `live` (the front few in the All cards browser) subscribe; the rest read the snapshot once, so a balance
 * change re-renders at most a handful of cards. The last value is kept on this device so a cold open shows the
 * last known balance at once.
 */
type Entry = { amount: number; unit: string; at: number };
const KEY = 'bw-card-balances';
const subs = new Map<string, Set<() => void>>();
let cache: Record<string, Entry> | null = null;

const all = (): Record<string, Entry> => {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Entry>;
  } catch {
    cache = {};
  }
  return cache;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const persist = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(all()));
    } catch {
      /* storage blocked: this session only */
    }
  }, 2000);
};

/** Publishes a card's balance. No-op when it has not changed, so callers may call it on every render. */
export function publishBalance(id: string, amount: number, unit: string): void {
  if (!Number.isFinite(amount)) return;
  const cur = all()[id];
  if (cur && cur.amount === amount && cur.unit === unit) return;
  cache = { ...all(), [id]: { amount, unit, at: Date.now() } };
  persist();
  subs.get(id)?.forEach((f) => f());
}

export const lastBalance = (id: string): Entry | null => all()[id] ?? null;

const noop = () => () => {};
/** A card's balance: live while `live`, otherwise the value at mount (last known). */
export function useCardBalance(id: string, live: boolean): Entry | null {
  return useSyncExternalStore(
    live
      ? (cb) => {
          let set = subs.get(id);
          if (!set) subs.set(id, (set = new Set()));
          set.add(cb);
          return () => set?.delete(cb);
        }
      : noop,
    () => all()[id] ?? null,
  );
}

/** For tests. */
export const _resetBalances = () => {
  cache = {};
  subs.clear();
};
