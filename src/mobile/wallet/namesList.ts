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

export type PaymailRow = { paymail: string; main: boolean };

/**
 * Wallet › Names › Paymail: the wallet's paymail handles from the server lookup (listPaymails), main one first.
 * Before the lookup answers, the cached paymail stands in as the main one. Duplicates (any case) are dropped.
 */
export const paymailRows = (
  names: readonly { paymail: string; main: boolean }[],
  cached: string | null | undefined,
  /** Sibling addresses (owner, 18 Oct 2026): each name@primary also shows name@<sibling>, same key, after it. */
  also?: { primary: string; siblings: readonly string[] },
): PaymailRow[] => {
  const src = names.length ? names : cached ? [{ paymail: cached, main: true }] : [];
  const seen = new Set<string>();
  const rows: PaymailRow[] = [];
  for (const n of src) {
    const key = n.paymail.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ paymail: n.paymail.trim(), main: !!n.main });
  }
  if (also?.primary) {
    const suffix = `@${also.primary.toLowerCase()}`;
    for (const r of [...rows]) {
      if (!r.paymail.toLowerCase().endsWith(suffix)) continue;
      const alias = r.paymail.slice(0, -suffix.length);
      for (const d of also.siblings) {
        const sib = `${alias}@${d.toLowerCase()}`;
        if (seen.has(sib)) continue;
        seen.add(sib);
        rows.splice(rows.indexOf(r) + 1, 0, { paymail: sib, main: false });
      }
    }
  }
  return rows.sort((a, b) => Number(b.main) - Number(a.main));
};

/** Wallet › Names › OpNS names: on-chain name tokens only. A paymail-shaped entry (has '@') is never an OpNS name. */
export const opnsRows = (rows: readonly WalletNameRow[]): WalletNameRow[] => rows.filter((r) => !r.name.includes('@'));
