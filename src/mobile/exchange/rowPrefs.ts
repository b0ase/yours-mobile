/**
 * Exchange row pins and hides (owner, 18 Oct 2026): swipe right on a token row for Pin · Hide.
 *
 * - Per wallet account (keyed by the identity address), in localStorage, shared by every Exchange list
 *   (Markets, People, Movies) through one in-memory subscriber set. Ids are BSV-21 token ids.
 * - Pinned rows sort to the top in pin order (newest pin last); hidden rows leave the list and show
 *   only under the "Hidden (n)" chip, where they can be unhidden.
 * Pure rules are unit-tested in rowPrefs.test.ts; the hook (useRowPrefs) is in useTokenRowActions.tsx.
 */

export type RowPrefs = { pinned: string[]; hidden: string[] };

export const emptyRowPrefs = (): RowPrefs => ({ pinned: [], hidden: [] });

const without = (xs: readonly string[], id: string) => xs.filter((x) => x !== id);

/** Pin goes to the end of the pinned group; unpin removes it. */
export const togglePinned = (p: RowPrefs, id: string): RowPrefs => ({
  ...p,
  pinned: p.pinned.includes(id) ? without(p.pinned, id) : [...p.pinned, id],
});

/** Hiding also unpins (a hidden row has no place at the top). */
export const toggleHidden = (p: RowPrefs, id: string): RowPrefs =>
  p.hidden.includes(id)
    ? { ...p, hidden: without(p.hidden, id) }
    : { pinned: without(p.pinned, id), hidden: [...p.hidden, id] };

/**
 * One list, arranged: pinned first (pin order), then the rest in the list's own order; hidden rows dropped.
 * `showHidden` returns only the hidden rows (in list order) for the "Hidden (n)" view.
 */
export const arrangeRows = <T>(items: readonly T[], idOf: (t: T) => string, p: RowPrefs, showHidden = false): T[] => {
  if (showHidden) return items.filter((t) => p.hidden.includes(idOf(t)));
  const live = items.filter((t) => !p.hidden.includes(idOf(t)));
  const rank = (t: T) => {
    const i = p.pinned.indexOf(idOf(t));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Stable: unpinned rows keep their order.
  return live
    .map((t, i) => ({ t, i, r: rank(t) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
};

/** How many of this list's rows are hidden (the chip count). */
export const hiddenCount = <T>(items: readonly T[], idOf: (t: T) => string, p: RowPrefs) =>
  items.filter((t) => p.hidden.includes(idOf(t))).length;

// ── Storage (per account) ──
const KEY = 'bwx:xrows:';

export const loadRowPrefs = (account: string | null | undefined): RowPrefs => {
  if (!account) return emptyRowPrefs();
  try {
    const v = JSON.parse(localStorage.getItem(KEY + account) ?? 'null') as Partial<RowPrefs> | null;
    if (!v || typeof v !== 'object') return emptyRowPrefs();
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    return { pinned: strs(v.pinned), hidden: strs(v.hidden) };
  } catch {
    return emptyRowPrefs();
  }
};

const subs = new Set<() => void>();

export const saveRowPrefs = (account: string | null | undefined, p: RowPrefs) => {
  if (!account) return;
  try {
    localStorage.setItem(KEY + account, JSON.stringify(p));
  } catch {
    /* storage full or unavailable */
  }
  subs.forEach((f) => f());
};

/** Subscribe to saves from any list; returns the unsubscribe. */
export const onRowPrefs = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
