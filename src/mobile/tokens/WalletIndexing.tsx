import { useEffect } from 'react';
import { indexingEnabled } from '../storeBuild';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { FinishIndexing } from './FinishIndexing';
import { notifyIfPermitted, recheckPendingIndexing, takeSessionReminder, usePendingIndexing } from './pendingIndexing';

/**
 * Wallet screen: a "Set up $X's room" card for each of the user's own tokens whose room isn't set up
 * (and that didn't get "Not now"), plus one reminder per app session (snackbar, and a local notification when permission
 * was already granted). The Wallet tab badge reads the same list (src/mobile/tabs/BottomMenu.tsx).
 */
/** Hidden in a store build (paid indexing, storeBuild.ts). */
export const WalletIndexing = (props: { exchangeRate?: number }) =>
  indexingEnabled() ? <WalletIndexingInner {...props} /> : null;

const WalletIndexingInner = ({ exchangeRate = 0 }: { exchangeRate?: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const list = usePendingIndexing(apiContext, identityAddress);

  useEffect(() => {
    if (!takeSessionReminder(list.length)) return;
    const text =
      list.length === 1
        ? `Set up $${list[0].ticker}'s room to list it in other wallets and the Market.`
        : `Set up rooms for ${list.length} of your tokens to list them in other wallets and the Market.`;
    addSnackbar(text, 'info');
    void notifyIfPermitted('Set up your token room', text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  if (!list.length) return null;
  return (
    <div className="flex w-[92%] flex-col gap-2 mt-4">
      {list.map((t) => (
        <FinishIndexing
          key={t.tokenId}
          tokenId={t.tokenId}
          ticker={t.ticker}
          exchangeRate={exchangeRate}
          compact
          onFunded={() => void recheckPendingIndexing(apiContext, identityAddress)}
        />
      ))}
    </div>
  );
};
