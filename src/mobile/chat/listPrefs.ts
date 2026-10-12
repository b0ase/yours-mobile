/**
 * Telegram-style chat list preferences, per identity (chat handle), in localStorage:
 * pinned (ordered), muted, archived, hidden ("Delete" = hide from this list) and marked-unread.
 *
 * Rules (pure, unit-tested in listPrefs.test.ts):
 * - Pinned chats sit at the top in pinned order; a newly pinned chat goes first.
 * - Archived chats go into one "Archived" group. A new message (activity newer than when it was
 *   archived) brings the chat back, unless it is muted (muted chats stay archived), as in Telegram.
 * - A hidden chat comes back when a newer message arrives.
 * - Everything else sorts by latest activity, newest first.
 */
import { useCallback, useEffect, useState } from 'react';

export type ListPrefs = {
  pinned: string[];
  muted: string[];
  /** key → activity time when archived. */
  archived: Record<string, number>;
  /** key → activity time when hidden (deleted locally). */
  hidden: Record<string, number>;
  /** Marked unread by hand (cleared when the chat is opened or marked read). */
  marked: string[];
};

export const emptyPrefs = (): ListPrefs => ({ pinned: [], muted: [], archived: {}, hidden: {}, marked: [] });

const without = (xs: string[], k: string) => xs.filter((x) => x !== k);

export const setPinned = (p: ListPrefs, key: string, on: boolean): ListPrefs => ({
  ...p,
  pinned: on ? [key, ...without(p.pinned, key)] : without(p.pinned, key),
});

/** Move a pinned chat to `index` in the pinned order. */
export const movePinned = (p: ListPrefs, key: string, index: number): ListPrefs => {
  if (!p.pinned.includes(key)) return p;
  const rest = without(p.pinned, key);
  const i = Math.max(0, Math.min(index, rest.length));
  return { ...p, pinned: [...rest.slice(0, i), key, ...rest.slice(i)] };
};

export const setMuted = (p: ListPrefs, key: string, on: boolean): ListPrefs => ({
  ...p,
  muted: on ? [...without(p.muted, key), key] : without(p.muted, key),
});

export const setArchived = (p: ListPrefs, key: string, on: boolean, at: number): ListPrefs => {
  const archived = { ...p.archived };
  if (on) archived[key] = at;
  else delete archived[key];
  // An archived chat is not pinned in the main list (Telegram unpins on archive).
  return { ...p, archived, pinned: on ? without(p.pinned, key) : p.pinned };
};

export const setHidden = (p: ListPrefs, key: string, on: boolean, at: number): ListPrefs => {
  const hidden = { ...p.hidden };
  if (on) hidden[key] = at;
  else delete hidden[key];
  return { ...p, hidden, pinned: on ? without(p.pinned, key) : p.pinned };
};

export const setMarked = (p: ListPrefs, key: string, on: boolean): ListPrefs => ({
  ...p,
  marked: on ? [...without(p.marked, key), key] : without(p.marked, key),
});

export const isMuted = (p: ListPrefs, key: string) => p.muted.includes(key);
export const isPinned = (p: ListPrefs, key: string) => p.pinned.includes(key);
export const isArchived = (p: ListPrefs, key: string) => key in p.archived;
export const isMarked = (p: ListPrefs, key: string) => p.marked.includes(key);

export type Arranged<T> = {
  /** Pinned first (pinned order), then by activity, newest first. */
  main: T[];
  archived: T[];
  /** Archived chats that a new message brought back: drop them from `archived` prefs. */
  unarchive: string[];
  /** Hidden chats that a new message brought back. */
  unhide: string[];
};

export const arrange = <T>(
  items: readonly T[],
  p: ListPrefs,
  keyOf: (x: T) => string,
  atOf: (x: T) => number,
): Arranged<T> => {
  const main: { x: T; i: number }[] = [];
  const archived: { x: T; i: number }[] = [];
  const unarchive: string[] = [];
  const unhide: string[] = [];
  items.forEach((x, i) => {
    const k = keyOf(x);
    const at = atOf(x);
    if (k in p.hidden) {
      if (at <= p.hidden[k]) return;
      unhide.push(k);
    }
    if (k in p.archived) {
      if (at <= p.archived[k] || p.muted.includes(k)) return void archived.push({ x, i });
      unarchive.push(k);
    }
    main.push({ x, i });
  });
  const pinPos = new Map(p.pinned.map((k, i) => [k, i]));
  const byActivity = (a: { x: T; i: number }, b: { x: T; i: number }) => atOf(b.x) - atOf(a.x) || a.i - b.i;
  main.sort((a, b) => {
    const pa = pinPos.get(keyOf(a.x));
    const pb = pinPos.get(keyOf(b.x));
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      return pa - pb;
    }
    return byActivity(a, b);
  });
  archived.sort(byActivity);
  return { main: main.map((e) => e.x), archived: archived.map((e) => e.x), unarchive, unhide };
};

/** Apply arrange()'s un-archive / un-hide results to the prefs (no change: same object). */
export const settle = (p: ListPrefs, a: Pick<Arranged<unknown>, 'unarchive' | 'unhide'>): ListPrefs => {
  if (!a.unarchive.length && !a.unhide.length) return p;
  const archived = { ...p.archived };
  const hidden = { ...p.hidden };
  a.unarchive.forEach((k) => delete archived[k]);
  a.unhide.forEach((k) => delete hidden[k]);
  return { ...p, archived, hidden };
};

// ── Storage (per identity) ──
const KEY = 'bwallet:chat-list-prefs:';
const norm = (identity: string) => identity.trim().replace(/^\$/, '').toLowerCase();

export const loadPrefs = (identity: string | null | undefined): ListPrefs => {
  if (!identity) return emptyPrefs();
  try {
    const v = JSON.parse(localStorage.getItem(KEY + norm(identity)) ?? 'null') as Partial<ListPrefs> | null;
    if (!v || typeof v !== 'object') return emptyPrefs();
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    const nums = (x: unknown) =>
      x && typeof x === 'object'
        ? Object.fromEntries(Object.entries(x).filter(([, n]) => typeof n === 'number'))
        : ({} as Record<string, number>);
    return {
      pinned: strs(v.pinned),
      muted: strs(v.muted),
      archived: nums(v.archived),
      hidden: nums(v.hidden),
      marked: strs(v.marked),
    };
  } catch {
    return emptyPrefs();
  }
};

const subs = new Set<() => void>();

export const savePrefs = (identity: string | null | undefined, p: ListPrefs) => {
  if (!identity) return;
  try {
    localStorage.setItem(KEY + norm(identity), JSON.stringify(p));
  } catch {
    /* storage full or unavailable */
  }
  subs.forEach((f) => f());
};

/** Is this room muted for the signed-in chat identity? (notify/engine.ts skips muted rooms.) */
export const isRoomMuted = (identity: string | null | undefined, ticker: string) =>
  loadPrefs(identity).muted.includes(roomKeyOf(ticker));

/** The prefs key for a room (rooms and DMs share one key space: the room ticker). */
export const roomKeyOf = (ticker: string) => ticker.replace(/^\$/, '').toUpperCase();

/** Prefs for one identity, shared live between Rooms and DMs. */
export const useListPrefs = (identity: string | null | undefined) => {
  const [prefs, setPrefs] = useState<ListPrefs>(() => loadPrefs(identity));
  useEffect(() => {
    setPrefs(loadPrefs(identity));
    const f = () => setPrefs(loadPrefs(identity));
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, [identity]);
  const update = useCallback(
    (fn: (p: ListPrefs) => ListPrefs) => {
      const next = fn(loadPrefs(identity));
      savePrefs(identity, next);
    },
    [identity],
  );
  return [prefs, update] as const;
};
