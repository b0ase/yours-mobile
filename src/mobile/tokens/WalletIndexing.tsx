import { useEffect } from 'react';
import { paidFeaturesEnabled } from '../storeBuild';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { FinishIndexing } from './FinishIndexing';
import { notifyIfPermitted, recheckPendingIndexing, takeSessionReminder, usePendingIndexing } from './pendingIndexing';

/**
 * Wallet screen: a "Finish setting up $X" card for each of the user's own tokens whose indexing fee
 * is unpaid, plus one reminder per app session (snackbar, and a local notification when permission
 * was already granted). The Wallet tab badge reads the same list (src/mobile/tabs/BottomMenu.tsx).
 */
/** Hidden in a store build (paid indexing, storeBuild.ts). */
export const WalletIndexing = (props: { exchangeRate?: number }) =>
  paidFeaturesEnabled() ? <WalletIndexingInner {...props} /> : null;

const WalletIndexingInner = ({ exchangeRate = 0 }: { exchangeRate?: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const list = usePendingIndexing(apiContext, identityAddress);

  useEffect(() => {
    if (!takeSessionReminder(list.length)) return;
    const what = list.length === 1 ? `$${list[0].ticker}` : `${list.length} of your tokens`;
    const text = `${what} needs its indexing fee paid before other wallets and the Market can see it.`;
    addSnackbar(text, 'info');
    void notifyIfPermitted('Finish setting up your token', text);
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
