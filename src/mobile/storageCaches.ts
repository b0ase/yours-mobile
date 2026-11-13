/**
 * localStorage caches that may be dropped when the web wallet's localStorage is full (webTab.ts owner record,
 * atomicStorage.ts writes). Moved out of webTab.ts so hub.ts can use them without loading the one-tab gate.
 */

/**
 * localStorage items that are only caches (fetched or rebuilt again on use), dropped when localStorage is full so the
 * wallet can still start: list caches (ui/listCache.ts), the thread cache fallback (chat/threadCache.ts), the "avatar
 * already published" markers (tabs/ChatPage.tsx), the previous boot trace and the private-build sync log. Avatar data
 * URLs (names/avatar.ts) are kept: for an unpublished photo that is the only copy the picker has.
 */
export const isDisposableCacheKey = (key: string) =>
  key.startsWith('bwallet:list-cache:') ||
  key === 'bwallet:thread-cache' ||
  key.startsWith('bwallet.chatAvatarPublished.') ||
  key === 'bwallet.bootTrace.prev' ||
  key === 'bwx.diag.syncLog';

export const freeDisposableCaches = (storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): number => {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && isDisposableCacheKey(k)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
  return keys.length;
};
