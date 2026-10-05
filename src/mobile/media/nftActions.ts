/**
 * NFT detail sheet + Wallet › NFTs Refresh: the pure parts (unit-tested in nftActions.test.ts).
 */

const OUTPOINT_RE = /^([0-9a-f]{64})[._](\d+)$/i;

/** `<txid>.<n>` or `<txid>_<n>` → `<txid>_<n>` (lowercase); '' when it is not an outpoint. */
export const normalizeOutpoint = (o?: string | null): string => {
  const m = (o || '').trim().match(OUTPOINT_RE);
  return m ? `${m[1].toLowerCase()}_${m[2]}` : '';
};

/** The avatar value for an NFT: `1sat://<origin>`, the same form AccountIconField stores for a pasted NFT id. */
export const nftAvatarUri = (origin: string): string => {
  const o = normalizeOutpoint(origin);
  return o ? `1sat://${o}` : '';
};

/** The NFT's page on 1satordinals.com. */
export const ordinalsUrl = (origin: string): string => {
  const o = normalizeOutpoint(origin);
  return o ? `https://1satordinals.com/outpoint/${o}` : '';
};

/** How many outpoints in `after` were not in `before`. */
export const countNew = (before: Iterable<string>, after: Iterable<string>): number => {
  const seen = new Set(before);
  let n = 0;
  for (const o of after) if (!seen.has(o)) n++;
  return n;
};

/** Short Refresh result for the NFTs header. */
export const refreshMessage = (added: number, synced = true): string => {
  if (added > 0) return `${added} new NFT${added === 1 ? '' : 's'}`;
  return synced ? 'Up to date' : 'Showing the latest the indexer has';
};
