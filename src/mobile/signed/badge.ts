import { useSyncExternalStore } from 'react';

/**
 * The ☰ › Signed badge count (documents waiting for me + seals held on this device), published by the Signed
 * recorder (signed/SignedMenu.tsx, a lazy bWalletX-only chunk) and read by the menu row and the wide sidebar. Tiny on
 * purpose: this file is the only part of Signed outside that chunk.
 */
let count = 0;
const listeners = new Set<() => void>();

export const setSignedBadge = (n: number): void => {
  const next = Math.max(0, Math.floor(Number(n) || 0));
  if (next === count) return;
  count = next;
  listeners.forEach((fn) => fn());
};
export const getSignedBadge = (): number => count;
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useSignedBadge = (): number => useSyncExternalStore(subscribe, getSignedBadge, getSignedBadge);
