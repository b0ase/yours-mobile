import { useSyncExternalStore } from 'react';
import { getListCoin, subscribeWalletKind } from './walletKind';

/** The coin the Tokens list is narrowed to (MNEE / PNEEs balance card), or null for every token. */
export const useListCoin = () => useSyncExternalStore(subscribeWalletKind, getListCoin, getListCoin);
