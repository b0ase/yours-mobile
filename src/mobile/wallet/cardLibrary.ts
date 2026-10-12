/* ── My pictures (owner, 12 Oct 2026) ─────────────────────────────────────────────────────────────────────────
   Under "Use my picture" in the card designer: a small library of pictures the account added, kept on this device
   only (localStorage, per account, like the card picture itself). Each picture is already resized by
   prepareCardImage (~100-200 KB), so the library is capped to stay well inside the browser's storage quota. */

/** Most pictures kept per account; the oldest drops off when a new one is added. */
export const CARD_LIBRARY_MAX = 12;

export type CardPicture = { id: string; uri: string };

const LIB_KEY = (key: string) => 'bw-card-lib:' + key.toLowerCase();

/** A short stable id for a picture, from its content (same picture added twice = same id). */
export function pictureId(uri: string): string {
  let h = 2166136261;
  for (let i = 0; i < uri.length; i++) {
    h ^= uri.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '-' + uri.length.toString(36);
}

/** Adds a picture to the front; a picture already there moves to the front; the list is capped at `max`. */
export function addPicture(list: CardPicture[], uri: string, max = CARD_LIBRARY_MAX): CardPicture[] {
  const id = pictureId(uri);
  return [{ id, uri }, ...list.filter((p) => p.id !== id)].slice(0, Math.max(0, max));
}

export function removePicture(list: CardPicture[], id: string): CardPicture[] {
  return list.filter((p) => p.id !== id);
}

/** The id of the library picture now on the card, or null when the card shows something else. */
export function selectedPictureId(list: CardPicture[], current: string | null | undefined): string | null {
  if (!current) return null;
  return list.find((p) => p.uri === current)?.id ?? null;
}

export function loadCardLibrary(identityPubKey: string | null | undefined): CardPicture[] {
  if (!identityPubKey) return [];
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LIB_KEY(identityPubKey)) ?? '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (p): p is CardPicture =>
          !!p && typeof p.id === 'string' && typeof p.uri === 'string' && p.uri.startsWith('data:image/'),
      )
      .slice(0, CARD_LIBRARY_MAX);
  } catch {
    return [];
  }
}

/** Saves the library. When the device is out of room, drops the oldest pictures until it fits; false if none fit. */
export function saveCardLibrary(identityPubKey: string | null | undefined, list: CardPicture[]): CardPicture[] | null {
  if (!identityPubKey) return null;
  for (let n = list.length; n >= 0; n--) {
    const kept = list.slice(0, n);
    try {
      if (kept.length) localStorage.setItem(LIB_KEY(identityPubKey), JSON.stringify(kept));
      else localStorage.removeItem(LIB_KEY(identityPubKey));
      return n === 0 && list.length ? null : kept;
    } catch {
      /* quota: try with one fewer */
    }
  }
  return null;
}
