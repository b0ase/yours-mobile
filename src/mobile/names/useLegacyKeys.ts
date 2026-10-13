import { useMemo } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { legacySigner, type LegacyKeys } from './existingToken';

/** This account's imported legacy (pay / ord) key addresses and a signer for them (keys decrypted per signature). */
export const useLegacyKeys = (): LegacyKeys => {
  const { keysService, chromeStorageService } = useServiceContext();
  const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const pay = a?.bsvAddress ?? '';
  const ord = a?.ordAddress ?? '';
  return useMemo(
    () =>
      legacySigner([pay, ord], async () => {
        const k = (await keysService.retrieveKeys()) as { walletWif?: string; ordWif?: string };
        return { walletWif: k.walletWif, ordWif: k.ordWif };
      }),
    [keysService, pay, ord],
  );
};
