import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { DEFAULT_RELAYX_ORD_PATH } from '../../utils/constants';
import { relayxXpub } from '../../sweep/relayxRecover';

/**
 * This account's RelayX xpub, if it was restored as a RelayX wallet. Saved at restore (RestoreAccount.tsx); when it
 * is missing, the account's own keys tell: a RelayX restore puts its ordinals key at RelayX's first NFT address
 * (m/44'/236'/0'/2/0). Then the xpub is worked out from the unlocked wallet and saved (owner, 17 Oct 2026: a
 * restored RelayX account showed nothing at all).
 */
export function useRelayxAccount(): string | undefined {
  const { chromeStorageService, keysService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const id = account?.addresses?.identityAddress;
  const saved = account?.settings?.relayx?.xpub;
  const [xpub, setXpub] = useState(saved);

  useEffect(() => {
    setXpub(saved);
    if (saved || !id) return;
    let live = true;
    void keysService
      .retrieveKeys()
      .then(async (k) => {
        if (!live || k.ordDerivationPath !== DEFAULT_RELAYX_ORD_PATH || !k.mnemonic) return;
        const x = relayxXpub(k.mnemonic);
        const current = chromeStorageService.getCurrentAccountObject().account;
        if (current?.addresses?.identityAddress === id)
          await chromeStorageService.updateNested('accounts', {
            [id]: { ...current, settings: { ...current.settings, relayx: { xpub: x } } },
          });
        if (live) setXpub(x);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per account
  }, [id, saved]);

  return xpub;
}
