/**
 * "Sell" opens the sell sheet straight away (owner, 13 Nov 2026: "the 'sell' card should come up straight away if
 * I click sell instead of seeing the order book... (let users see the order book too if they want to though)").
 * Every Sell button (wallet token rows, Exchange rows, the phone Market's token page) uses this instead of
 * navigating to the trade screen; the order book stays on the token page.
 *
 * It reads this wallet's balance of that token ID (never the ticker) and opens SellSheet with it. SellSheet
 * checks the token's decimals itself, so a balance filed without `dec` still sells in fractions.
 */
import { useCallback, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { SellSheet, type SellTarget } from './SellSheet';
import { SELL_ENABLED, sellTargetFor } from './sell';

export const useSellSheet = () => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [target, setTarget] = useState<SellTarget | null>(null);

  /** Open the sheet for a token you hold; `known` skips the balance read when the caller has it. */
  const openSell = useCallback(
    async (tokenId: string, symbol = '', known?: SellTarget) => {
      if (!SELL_ENABLED) return;
      if (known) return setTarget(known);
      const t = sellTargetFor(await heldBsv21Balances(apiContext).catch(() => []), tokenId, symbol);
      if (t) setTarget(t);
      else
        addSnackbar(
          `You don't hold any ${symbol ? `$${symbol.replace(/^\$/, '')}` : 'of this token'} to sell.`,
          'info',
        );
    },
    [apiContext, addSnackbar],
  );

  const sellSheet = SELL_ENABLED && target ? <SellSheet target={target} onClose={() => setTarget(null)} /> : null;

  return { openSell, sellSheet };
};
