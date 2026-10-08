import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { badgeCount, loadInbox, loadItems, saveInbox, subscribeInbox, visibleItems, type InboxState } from './inbox';
import { refreshAirdrops } from './load';

let version = 0;
subscribeInbox(() => {
  version++;
});

/** The active account's airdrops inbox: items, state, badge, actions. Refreshes in the background. */
export const useAirdrops = () => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const account = a?.identityAddress ?? '';
  const addresses = useMemo(
    () => [...new Set([a?.ordAddress, a?.bsvAddress, a?.identityAddress].filter((x): x is string => !!x))],
    [a?.ordAddress, a?.bsvAddress, a?.identityAddress],
  );
  const v = useSyncExternalStore(subscribeInbox, () => version);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => loadItems(account).items, [account, v]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => loadInbox(account), [account, v]);

  const refresh = useCallback(
    (force = false) => {
      setLoading(true);
      setError('');
      refreshAirdrops(account, addresses, apiContext.wallet as never, apiContext.wocApiKey || undefined, force)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [account, addresses, apiContext],
  );
  useEffect(() => refresh(false), [refresh]);

  const update = useCallback(
    (f: (s: InboxState) => InboxState) => saveInbox(account, f(loadInbox(account))),
    [account],
  );
  return {
    items,
    visible: visibleItems(items, state),
    state,
    badge: badgeCount(items, state),
    loading,
    error,
    refresh,
    update,
    airdropAddress: a?.ordAddress ?? '',
  };
};

/** The active account's airdrop address ('' when none). Also for the planned public profile page. */
export const useAirdropAddress = () => {
  const { chromeStorageService } = useServiceContext();
  return chromeStorageService.getCurrentAccountObject().account?.addresses?.ordAddress ?? '';
};
