/**
 * Last token balances per account (owner round 6: the Wallet renders from cache at once, then refreshes quietly).
 * Plain JSON in localStorage; a missing or broken entry is just an empty list.
 */
const key = (id: string) => `bwallet:bsv21-cache:${id}`;

export const loadTokenCache = <T>(id: string | undefined): T[] => {
  if (!id) return [];
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key(id)) ?? '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export const saveTokenCache = (id: string | undefined, tokens: unknown[]) => {
  if (!id) return;
  try {
    localStorage.setItem(key(id), JSON.stringify(tokens, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    /* storage full or unavailable: no cache */
  }
};
