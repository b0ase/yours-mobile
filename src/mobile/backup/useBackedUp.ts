import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { currentBackupSettings, isBackedUp, onBackupChange } from './backupState';

/** Has the current account completed a backup? Updates when it does. */
export const useBackedUp = () => {
  const { chromeStorageService } = useServiceContext();
  const [backedUp, setBackedUp] = useState(() => isBackedUp(currentBackupSettings(chromeStorageService)));
  useEffect(() => {
    const update = () => setBackedUp(isBackedUp(currentBackupSettings(chromeStorageService)));
    update();
    return onBackupChange(update);
  }, [chromeStorageService]);
  return backedUp;
};
