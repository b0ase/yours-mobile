/**
 * Wallet token rows: pin, archive and order (owner, 15 Oct 2026). Per device (localStorage), shared by every
 * list through a window event. Row ids: 'bsv', 'mnee', or a BSV-21 token id.
 */
import { useEffect, useState } from 'react';

const ARCHIVED = 'bwallet:archived-token-rows';
const PINNED = 'bwallet:pinned-token-rows';
const EVENT = 'bwallet:token-rows';

const readList = (key: string): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeList = (key: string, ids: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* storage unavailable: lasts this session only */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const readArchived = () => readList(ARCHIVED);
export const readPinned = () => readList(PINNED);
export const setArchived = (id: string, on: boolean) => {
  const now = readArchived().filter((x) => x !== id);
  writeList(ARCHIVED, on ? [...now, id] : now);
};
/** Pin goes to the end of the pinned group (pin order); unpin removes it. */
export const togglePin = (pinned: readonly string[], id: string): string[] =>
  pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
export const setPinned = (ids: string[]) => writeList(PINNED, ids);

/** Split an ordered list into the pinned group (in pin order) and the rest (in list order); archived dropped. */
export const arrange = <T>(
  items: readonly T[],
  idOf: (t: T) => string,
  pinned: readonly string[],
  archived: readonly string[] = [],
): { pinned: T[]; rest: T[]; archived: T[] } => {
  const byId = new Map(items.map((t) => [idOf(t), t]));
  const live = items.filter((t) => !archived.includes(idOf(t)));
  return {
    pinned: pinned
      .filter((id) => !archived.includes(id))
      .map((id) => byId.get(id))
      .filter((t): t is T => t !== undefined),
    rest: live.filter((t) => !pinned.includes(idOf(t))),
    archived: items.filter((t) => archived.includes(idOf(t))),
  };
};

/** Move one item from index `from` to index `to` (both within the same list). */
export const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const n = [...list];
  const [x] = n.splice(from, 1);
  n.splice(Math.max(0, Math.min(to, n.length)), 0, x);
  return n;
};

/**
 * Apply a reordered group (e.g. the unpinned rows, after a drag) back onto the full order: the group's
 * positions in `full` are refilled in the group's new order; everything else stays put.
 */
export const applyGroupOrder = (full: readonly string[], group: readonly string[]): string[] => {
  const set = new Set(group);
  let i = 0;
  return full.map((id) => (set.has(id) ? group[i++] : id));
};

/** Pinned and archived ids, kept in sync across lists. */
export const useTokenRows = (): { pinned: string[]; archived: string[] } => {
  const [v, setV] = useState(() => ({ pinned: readPinned(), archived: readArchived() }));
  useEffect(() => {
    const f = () => setV({ pinned: readPinned(), archived: readArchived() });
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return v;
};
