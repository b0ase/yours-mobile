import { useEffect, useSyncExternalStore } from 'react';
import type { Bsv21Balance } from '@1sat/actions';
import { WIDE_ON } from './flag';

/** The Wallet page's own balances, shared with the wide layout's token table (no second fetch). */
export type WalletFeed = { bsvBalance: number; mneeBalance: number; exchangeRate: number; bsv21s: Bsv21Balance[] };

let feed: WalletFeed | null = null;
const subs = new Set<() => void>();

/** Called by BsvWallet (build-time patch, vite.config.mobile.ts). Does nothing outside the wide layout. */
export const useWideWalletFeed = (f: WalletFeed) => {
  const { bsvBalance, mneeBalance, exchangeRate, bsv21s } = f;
  useEffect(() => {
    if (!WIDE_ON) return;
    feed = { bsvBalance, mneeBalance, exchangeRate, bsv21s };
    subs.forEach((s) => s());
  }, [bsvBalance, mneeBalance, exchangeRate, bsv21s]);
};

const subscribe = (s: () => void) => {
  subs.add(s);
  return () => subs.delete(s);
};
export const useWalletFeed = () => useSyncExternalStore(subscribe, () => feed);
