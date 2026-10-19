import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { notifyAvatarChange, paymailAvatar, resolveAvatarUrl, setLocalAvatar, toAvatarUri } from './avatar';
import { removeAccountPhoto } from './socialAvatar';

/**
 * "Your picture" (owner, 13 Oct 2026): tap the avatar on the card front to pick where the account's picture
 * comes from: the linked X / Google photo, an image NFT it owns, or its gold bAvatar. The picture is written
 * where every surface already reads it (avatar.ts: account socialProfile.avatar + icon, read by the card,
 * TopNav, chat profile publish and the paymail profile), so card, chat and paymail always agree.
 *
 * The bAvatar is never lost: it is drawn from the identity key (bavatarDataUri), so "Use my bAvatar" just
 * clears the chosen picture. The NFT library keeps a "Your bAvatar" item (minted or not) so it stays visible.
 * Local only; nothing here signs or broadcasts.
 */

export type PictureSource = 'bavatar' | 'x' | 'google' | 'nft' | 'photo';
export type LinkedSocial = { provider: 'x' | 'google'; handle: string; avatar: string; at: number };
export type PictureState = { source: PictureSource; url?: string; outpoint?: string };

const SRC = (id: string) => `bwallet.picture.${id}`;
const LINKED = (id: string) => `bwallet.linkedSocial.${id}`;

const getJson = <T>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') as T | null;
  } catch {
    return null;
  }
};
const setJson = (k: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Where this account's picture comes from; with nothing recorded, the gold bAvatar. */
export const pictureState = (id?: string): PictureState =>
  (id && getJson<PictureState>(SRC(id))) || { source: 'bavatar' };
export const savePictureState = (id: string, s: PictureState) => setJson(SRC(id), s.source === 'bavatar' ? null : s);

/** The X / Google account linked to this account (its handle and photo), or null. */
export const linkedSocial = (id?: string): LinkedSocial | null => (id ? getJson<LinkedSocial>(LINKED(id)) : null);
export const saveLinkedSocial = (id: string, l: LinkedSocial | null) => setJson(LINKED(id), l);

/** The handle to show for a verified profile: X as @name, Google as its display name or email user. */
export const socialHandle = (p: { provider: 'x' | 'google'; name: string; display?: string | null }) =>
  p.provider === 'x' ? '@' + p.name.replace(/^@/, '') : p.display || p.name.split('@')[0];

/** An NFT's https picture URL (ORDFS) from its origin/outpoint, for the account, chat and paymail profile. */
export const nftPictureUrl = (origin: string) => resolveAvatarUrl(toAvatarUri(origin.replace('.', '_')));

/** Is this library item the account's minted bAvatar? (mintBavatar names it "$handle · bWalletX #n"). */
export const isBavatarItem = (name: string | null | undefined) => /· bWalletX #\d+$/.test(String(name || ''));

/** Write a picture URL where every surface reads it (account icon + socialProfile.avatar), clearing the local photo. */
async function writeAccountPicture(storage: ChromeStorageService, id: string, url: string) {
  const account = storage.getAllAccounts?.().find((a) => a.addresses.identityAddress === id);
  setLocalAvatar(id, '');
  if (account) {
    const key: keyof ChromeStorageObject = 'accounts';
    await storage
      .updateNested(key, {
        [id]: {
          ...account,
          icon: url,
          settings: { ...account.settings, socialProfile: { ...account.settings.socialProfile, avatar: url } },
        },
      } as Partial<ChromeStorageObject['accounts']>)
      .catch(() => undefined);
  }
  notifyAvatarChange();
}

/**
 * Switch the account's picture. Returns the https URL now public-safe for the paymail profile ('' for the
 * bAvatar, which the paymail profile can't clear today; see the report).
 */
export async function setPicture(
  storage: ChromeStorageService,
  id: string,
  choice:
    | { source: 'bavatar' }
    | { source: 'x' | 'google' }
    /** `url`: a public https picture for this NFT (e.g. an NPG Avatar's circle); else its ORDFS content. */
    | { source: 'nft'; origin: string; url?: string },
): Promise<string> {
  if (!id) return '';
  if (choice.source === 'bavatar') {
    savePictureState(id, { source: 'bavatar' });
    await removeAccountPhoto(storage, id);
    return '';
  }
  if (choice.source === 'nft') {
    const url = paymailAvatar(choice.url) || nftPictureUrl(choice.origin);
    savePictureState(id, { source: 'nft', url, outpoint: choice.origin.replace('.', '_') });
    await writeAccountPicture(storage, id, url);
    return paymailAvatar(url);
  }
  const linked = linkedSocial(id);
  if (!linked || linked.provider !== choice.source || !linked.avatar) return '';
  savePictureState(id, { source: choice.source, url: linked.avatar });
  await writeAccountPicture(storage, id, linked.avatar);
  return paymailAvatar(linked.avatar);
}

/** Back from X / Google with a verified profile: link it to the account and use its photo. */
export async function adoptLinkedProfile(
  storage: ChromeStorageService,
  id: string,
  p: { provider: 'x' | 'google'; name: string; display?: string | null; avatar?: string | null },
): Promise<string> {
  saveLinkedSocial(id, { provider: p.provider, handle: socialHandle(p), avatar: p.avatar || '', at: Date.now() });
  return p.avatar ? setPicture(storage, id, { source: p.provider }) : '';
}
