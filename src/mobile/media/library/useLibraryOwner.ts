import { useEffect, useState } from 'react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { getPaymail, getPrimaryName, onAccountNamesChange } from '../../names/accountName';
import { isLibraryOwner } from './library';

/** Whether to show the private library shelf: the signed-in wallet's handle is the owner's. Cosmetic only. */
export const useLibraryOwner = (): boolean => {
  const { chromeStorageService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const check = () => isLibraryOwner(getPaymail(id)) || isLibraryOwner(getPrimaryName(id));
  const [owner, setOwner] = useState(check);
  useEffect(() => {
    setOwner(check());
    return onAccountNamesChange(() => setOwner(check()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return owner;
};
