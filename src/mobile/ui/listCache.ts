/**
 * Cache-first lists (owner round 6): the last good copy of a list in localStorage, shown the moment a page opens
 * while the live copy loads quietly. Capped; any read problem is just "no cache".
 */
const PREFIX = 'bwallet:list-cache:';

export const readListCache = <T>(key: string): T[] | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null');
    return Array.isArray(v) ? (v as T[]) : null;
  } catch {
    return null;
  }
};

export const writeListCache = (key: string, items: readonly unknown[], max = 40) => {
  try {
    localStorage.setItem(
      PREFIX + key,
      JSON.stringify(items.slice(0, max), (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  } catch {
    /* storage full or unavailable */
  }
};
