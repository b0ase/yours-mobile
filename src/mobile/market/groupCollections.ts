/**
 * Market › 3D (owner, 8 Oct 2026): repetitive collections (e.g. "Kowry Glider #001…#0nn") crowd out
 * everything else. Collapse any collection with `min` or more listings into one tile ("Name (N)") and
 * rank those groups after the one-off listings. Nothing is hidden: a group expands in place on tap.
 */
export interface Groupable {
  name: string;
  collectionId: string | null;
  collectionName?: string | null;
}

export interface Grouped<T> {
  item: T;
  /** Grouping key, or null for a listing shown on its own. */
  key: string | null;
  /** Listings in the collapsed group (including `item`); 1 for singles and expanded members. */
  count: number;
  /** Display label for a collapsed group. */
  label: string;
}

/** Name without its trailing serial: "Kowry Glider #003" -> "Kowry Glider". */
export const nameStem = (name: string): string => name.replace(/\s*[#№]?\s*\d+\s*$/, '').trim() || name.trim();

export const groupKey = (n: Groupable): string =>
  n.collectionId ? `c:${n.collectionId}` : `n:${nameStem(n.name).toLowerCase()}`;

export function groupCollections<T extends Groupable>(
  items: T[],
  expanded: ReadonlySet<string> = new Set(),
  min = 3,
): Grouped<T>[] {
  const buckets = new Map<string, T[]>();
  for (const n of items) {
    const k = groupKey(n);
    const b = buckets.get(k);
    if (b) b.push(n);
    else buckets.set(k, [n]);
  }
  const singles: Grouped<T>[] = [];
  const groups: Grouped<T>[] = [];
  const seen = new Set<string>();
  for (const n of items) {
    const k = groupKey(n);
    const b = buckets.get(k)!;
    if (b.length < min) {
      singles.push({ item: n, key: null, count: 1, label: n.name });
      continue;
    }
    if (expanded.has(k)) {
      groups.push({ item: n, key: k, count: 1, label: n.name });
      continue;
    }
    if (seen.has(k)) continue;
    seen.add(k);
    const label = n.collectionName?.trim() || nameStem(n.name);
    groups.push({ item: n, key: k, count: b.length, label: `${label} (${b.length})` });
  }
  return [...singles, ...groups];
}
