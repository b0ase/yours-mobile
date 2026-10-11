import { avatarFor } from './avatars';
import { faceArtLocal, faceArtUrl } from '../spaces/faceArt';

/**
 * Pictures to try, in order, for a room or person with no picture of its own (owner, 11 Oct 2026, "gold by
 * default"): the issuer's profile photo (their X / Google picture, once known), then their gold bAvatar from
 * bChatX, then a bAvatar drawn on the device. Never a letter on a coloured disc. A personal token room's ticker is
 * its issuer's handle ($VEXVOID ↔ $vexvoid), so the title is the fallback seed when the issuer isn't known.
 */
export const defaultPictures = (title: string, issuerHandle?: string | null): string[] => {
  const seed = (issuerHandle || title || 'b').replace(/^\$/, '').trim().toLowerCase() || 'b';
  const photo = avatarFor(seed);
  return [...(photo ? [photo] : []), faceArtUrl(seed), faceArtLocal(seed)];
};
