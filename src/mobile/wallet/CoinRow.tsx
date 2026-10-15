import type { ReactNode } from 'react';
import { rowMatchesCoin } from './cardFilter';
import { useListCoin } from './useListCoin';

/** A Tokens-list row that hides (stays mounted) while a coin card narrows the list to another coin. */
export const CoinRow = ({ id, children }: { id: string; children: ReactNode }) => {
  const coin = useListCoin();
  return <div style={{ display: rowMatchesCoin(id, coin) ? 'contents' : 'none' }}>{children}</div>;
};
