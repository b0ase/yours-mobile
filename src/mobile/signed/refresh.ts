import { setSignedBadge } from './badge';
import { heldFor, readHeldSeals } from './held';
import { loadCachedSync, loadLocal } from './localStore';
import { badgeCount, mergeRows } from './signedList';

/**
 * Recount the ☰ › Signed badge for this account: documents waiting for my signature and documents with a seal held on
 * this device, each document once. In the lazy Signed chunk (badge.ts, outside it, only holds the number).
 */
export const refreshSignedBadge = (identityKey: string): void => {
  if (!identityKey) return setSignedBadge(0);
  const rows = mergeRows(loadLocal(identityKey), loadCachedSync(identityKey)?.rows ?? []);
  setSignedBadge(badgeCount(rows, new Set(heldFor(identityKey, readHeldSeals()).map((p) => p.documentId))));
};
