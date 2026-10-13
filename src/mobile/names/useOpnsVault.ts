import { useEffect, useState } from 'react';
import { isStudioOwner } from '../bmint/lib/studioAccess';
import { OWNER_GIFT, OWNER_KEEP } from './ownerVault';
import { loadVault, saveVault, withBuiltIn, type VaultState } from './opnsVault';

/** The OpNS Vault for this identity; the owner's built-in lists are merged in for studio identities. */
export const useOpnsVault = (identityAddress: string, identityPubKey?: string) => {
  const builtIn = isStudioOwner({ identityAddress, identityPubKey }) ? { keep: OWNER_KEEP, gift: OWNER_GIFT } : null;
  const read = () => withBuiltIn(loadVault(identityAddress), builtIn);
  const [state, setState] = useState<VaultState>(read);
  useEffect(() => setState(read()), [identityAddress, identityPubKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: VaultState) => {
    saveVault(identityAddress, v);
    setState(withBuiltIn(v, builtIn));
  };
  return { state, set, current: read };
};
