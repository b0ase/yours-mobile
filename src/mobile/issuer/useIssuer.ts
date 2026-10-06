import { useEffect, useState } from 'react';
import { cachedIssuer, verifyIssuer, type IssuerInfo } from './issuerVerify';

/** The issuer of `tokenId` (cached; verifies in the background). */
export function useIssuer(tokenId: string | null | undefined): IssuerInfo | null {
  const [info, setInfo] = useState<IssuerInfo | null>(() => (tokenId ? cachedIssuer(tokenId) : null));
  useEffect(() => {
    if (!tokenId) return setInfo(null);
    let live = true;
    setInfo(cachedIssuer(tokenId));
    verifyIssuer(tokenId)
      .then((i) => live && setInfo(i))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tokenId]);
  return info;
}
