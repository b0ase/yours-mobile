import type { OwnedName } from '../names/accountName';
import type { OwnedForSale } from '../names/opnsSell';

export type WalletNameRow = { name: string; id: string; published: boolean; listedSats: number | null };

/** One row per OpNS name: bound state (accountName.ts) joined with listing state (opnsSell.ts), sorted by name. */
export const mergeNames = (bound: readonly OwnedName[], forSale: readonly OwnedForSale[]): WalletNameRow[] => {
  const rows = new Map<string, WalletNameRow>();
  for (const b of bound) rows.set(b.name, { name: b.name, id: b.id, published: b.published, listedSats: null });
  for (const s of forSale) {
    const r = rows.get(s.name);
    if (r) r.listedSats = s.listedSats;
    else rows.set(s.name, { name: s.name, id: s.id, published: false, listedSats: s.listedSats });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
};
