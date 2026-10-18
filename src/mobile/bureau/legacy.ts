import type { VaultItem } from './api';

/** bit-sign's placeholder txid (`pending-…`) is not a transaction: only a real one counts as sealed. */
export const onChainTxid = (row: Pick<VaultItem, 'txid' | 'seal_txid'>): string | null => {
  for (const t of [row.seal_txid, row.txid]) if (typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t)) return t;
  return null;
};

export const vaultItemName = (v: VaultItem): string => {
  const m = (v.metadata ?? {}) as Record<string, unknown>;
  const raw = [m.originalFileName, m.fileName, m.documentTitle, m.title].find((x) => typeof x === 'string' && x.trim());
  return typeof raw === 'string'
    ? raw.trim()
    : `${v.signature_type.replace(/_/g, ' ').toLowerCase()} · ${v.id.slice(0, 8)}`;
};
