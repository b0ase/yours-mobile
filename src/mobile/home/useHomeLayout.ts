import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { WIDE_ON } from '../wide/flag';
import { DEFAULT_LAYOUT, WIDE_DEFAULT_LAYOUT, loadLayout, onLayoutChange, saveLayout, type ModuleId } from './layout';

const defaults = () => (WIDE_ON ? WIDE_DEFAULT_LAYOUT : DEFAULT_LAYOUT);

/** The current account's home layout, live across every component that shows it. */
export const useHomeLayout = () => {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [ids, setIds] = useState(() => loadLayout(account, defaults(), WIDE_ON));
  useEffect(() => {
    setIds(loadLayout(account, defaults(), WIDE_ON));
    return onLayoutChange(() => setIds(loadLayout(account, defaults(), WIDE_ON)));
  }, [account]);
  const set = (next: ModuleId[]) => {
    setIds(next);
    saveLayout(account, next);
  };
  return { ids, set };
};
