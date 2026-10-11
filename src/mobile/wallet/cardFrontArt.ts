import { bavatarSvg } from '../bavatar/bavatar';

/**
 * The front of the wallet card (owner, 11 Oct 2026): the account's bAvatar art, the same blend bChatX
 * uses as a profile's default banner and the wallet uses as the default avatar. Seeded by the identity
 * key exactly as names/avatar.ts bavatarDataUri() and bChatX /api/bavatar, so all three match. Drawn
 * locally (no network) and cached per key, so the home screen draws it once per account.
 *
 * bWallet (store edition) keeps its yellow card: no art there. An account with its own uploaded picture
 * keeps that picture as its avatar; the card art is still its bAvatar.
 */
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const cache = new Map<string, string>();

/** Data URI of the card-front art, or '' (yellow bWallet card, or no identity key yet). */
export function cardFrontArtUri(identityPubKey: string | null | undefined, yellowCard: boolean): string {
  if (yellowCard) return '';
  const key = String(identityPubKey ?? '')
    .trim()
    .toLowerCase();
  if (!KEY_RE.test(key)) return '';
  let uri = cache.get(key);
  if (!uri) {
    uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(key, { size: 512, label: '' }));
    cache.set(key, uri);
  }
  return uri;
}
