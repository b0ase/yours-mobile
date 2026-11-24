import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAvatar } from '../names/useAvatar';
import { getPersonalLink, normId, personalTicker } from '../names/personalToken';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { useIssuer } from '../issuer/useIssuer';
import {
  cachedOverride,
  onOverrideChange,
  overrideIconUrl,
  resolveIconOverride,
  type IconOverride,
} from './iconOverride';
import { hasPinnedArt } from './officialTokens';

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

export type TokenIcon = { url: string; fromProfile: boolean; own: boolean; fromOverride?: boolean };

/** The newest valid issuer-signed icon for a token (tokens/iconOverride), once its issuer is verified. */
export const useIconOverride = (tokenId: string | undefined): IconOverride | null => {
  const issuer = useIssuer(hasPinnedArt(tokenId) ? undefined : tokenId);
  const key = issuer?.status === 'verified' ? issuer.identityKey : undefined;
  const [found, setFound] = useState<IconOverride | null>(null);
  useEffect(() => {
    if (!tokenId || !key) return setFound(null);
    let live = true;
    setFound(cachedOverride(tokenId, key) ?? null);
    void resolveIconOverride(tokenId, key).then((o) => live && setFound(o));
    // A publish (or any fresh lookup) updates the cache: show it without a reload.
    const off = onOverrideChange((id) => {
      if (live && id === tokenId.trim().toLowerCase().replace('.', '_')) setFound(cachedOverride(tokenId, key) ?? null);
    });
    return () => {
      live = false;
      off();
    };
  }, [tokenId, key]);
  return found;
};

export const useTokenIcon = (tokenId: string | undefined, ticker: string, onchain: string): TokenIcon => {
  const { chromeStorageService } = useServiceContext();
  const me = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const ownId = useOwnPersonalTokenId();
  const pinned = hasPinnedArt(tokenId);
  const own = !pinned && !!tokenId && !!ownId && normId(tokenId) === ownId;
  const myAvatar = useAvatar(me);
  const issuer = useIssuer(own ? null : tokenId);
  const override = useIconOverride(tokenId);
  const [theirs, setTheirs] = useState('');
  const personal = !pinned && !own && issuer?.status === 'verified' && isPersonalFor(ticker, issuer.paymail);
  useEffect(() => {
    if (!personal || !issuer?.paymail) return;
    let live = true;
    void profileAvatar(issuer.paymail).then((a) => live && setTheirs(a));
    return () => {
      live = false;
    };
  }, [personal, issuer?.paymail]);
  // Official / pinned art always wins: no profile picture and no issuer-signed update replaces it.
  if (pinned) return { url: onchain, fromProfile: false, own: false };
  if (own && myAvatar) return { url: myAvatar, fromProfile: true, own };
  if (personal && theirs) return { url: theirs, fromProfile: true, own };
  if (override) return { url: overrideIconUrl(override), fromProfile: false, own, fromOverride: true };
  return { url: onchain, fromProfile: false, own };
};
