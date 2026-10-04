import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAvatar } from '../names/AccountAvatar';
import { getPersonalLink, normId, personalTicker } from '../names/personalToken';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { useIssuer } from '../issuer/IssuerBadge';

/**
 * Personal-token icons (owner, 4 Oct 2026). A BSV-21 icon is fixed on chain at deploy, so inside
 * bWalletX a PERSONAL token ($B0ASEX for b0asex.x) shows its creator's current profile picture
 * instead. Safe because the token's signed issuer statement ties it to the creator's identity key,
 * and only a token whose ticker is that creator's own name counts. Other wallets and 1Sat still
 * show the on-chain icon.
 */

const avatars = new Map<string, Promise<string>>();
/** A paymail's public profile picture ('' if none). */
export const profileAvatar = (paymail: string): Promise<string> => {
  let p = avatars.get(paymail);
  if (!p) {
    p = fetch(`${BWALLET_PAYMAIL_API}/api/paymail/profile/${encodeURIComponent(paymail)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (typeof j?.avatar === 'string' ? j.avatar : ''))
      .catch(() => '');
    avatars.set(paymail, p);
  }
  return p;
};

/** This wallet's own personal token id, if it has minted one. */
export const useOwnPersonalTokenId = (): string | null => {
  const { chromeStorageService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  return normId(getPersonalLink(id)?.tokenId);
};

/** Is this the token named after its creator's own paymail? */
export const isPersonalFor = (ticker: string, paymail: string | null | undefined) => {
  const t = personalTicker(paymail || '');
  return !!t && t === (ticker || '').replace(/^\$/, '').toUpperCase();
};

export type TokenIcon = { url: string; fromProfile: boolean; own: boolean };

export const useTokenIcon = (tokenId: string | undefined, ticker: string, onchain: string): TokenIcon => {
  const { chromeStorageService } = useServiceContext();
  const me = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const ownId = useOwnPersonalTokenId();
  const own = !!tokenId && !!ownId && normId(tokenId) === ownId;
  const myAvatar = useAvatar(me);
  const issuer = useIssuer(own ? null : tokenId);
  const [theirs, setTheirs] = useState('');
  const personal = !own && issuer?.status === 'verified' && isPersonalFor(ticker, issuer.paymail);
  useEffect(() => {
    if (!personal || !issuer?.paymail) return;
    let live = true;
    void profileAvatar(issuer.paymail).then((a) => live && setTheirs(a));
    return () => {
      live = false;
    };
  }, [personal, issuer?.paymail]);
  if (own && myAvatar) return { url: myAvatar, fromProfile: true, own };
  if (personal && theirs) return { url: theirs, fromProfile: true, own };
  return { url: onchain, fromProfile: false, own };
};
