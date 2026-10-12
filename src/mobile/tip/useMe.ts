import { useEffect, useState } from 'react';
import { PublicKey } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { accountNamesFor } from '../names/accountNames';
import type { Me } from './tip';

/** This account's identity key, address and names (for "can't tip yourself"). Cached per wallet. */
export const useMe = (): Me | null => {
  const { apiContext } = useServiceContext();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    const w = apiContext?.wallet;
    if (!w) return;
    w.getPublicKey({ identityKey: true })
      .then(({ publicKey }) => {
        if (!live) return;
        const address = PublicKey.fromString(publicKey).toAddress();
        const n = accountNamesFor(address);
        setMe({ identityKey: publicKey, address, names: [n.handle, n.paymail, n.payable] });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext?.wallet]);
  return me;
};
