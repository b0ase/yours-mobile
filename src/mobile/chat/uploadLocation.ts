import { locationVerdict, shareBlockedMessage, stripJpegLocation } from '../private/location';

/**
 * The location gate for everything the wallet sends to bChat (b-Aware #288): room photos, videos, voice notes and
 * files (BchatClient.uploadMedia, which the chat bar, voice notes and commission clips all use), my picture and a
 * room cover. bit-sign keeps the bytes exactly as sent and serves them to every member, and any member can then
 * inscribe a room file publicly on chain (bit-sign rooms/[ticker]/media/[id]/stamp, mode 'full'). So nothing leaves
 * the device with location in it:
 *   - nothing found: sent as it is;
 *   - a JPEG with (possible) location: its metadata is removed (private/location.ts stripJpegLocation, orientation
 *     kept) and the copy is sent only if it then reads as clean;
 *   - anything else with (possible) location: refused, nothing is sent.
 */
export type CleanUpload = { ok: true; bytes: Uint8Array; stripped: boolean } | { ok: false; message: string };

export function cleanForUpload(bytes: Uint8Array, mime: string): CleanUpload {
  const v = locationVerdict(bytes, mime);
  if (v === 'none') return { ok: true, bytes, stripped: false };
  const clean = stripJpegLocation(bytes);
  if (clean && locationVerdict(clean, 'image/jpeg') === 'none') return { ok: true, bytes: clean, stripped: true };
  return { ok: false, message: shareBlockedMessage(mime, v) };
}

/** A File ready to send: the same one, or a JPEG copy without metadata. Throws the reason when it can't be sent. */
export async function cleanFileForUpload(file: File): Promise<File> {
  const r = cleanForUpload(new Uint8Array(await file.arrayBuffer()), file.type);
  if (!r.ok) throw new Error(r.message);
  if (!r.stripped) return file;
  return new File([r.bytes as BlobPart], file.name, {
    type: file.type || 'image/jpeg',
    lastModified: file.lastModified,
  });
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * A data URL ready to send (my picture, a room cover): the same one, or a base64 JPEG copy without metadata.
 * Throws the reason when it can't be sent (one that doesn't decode counts as "may contain").
 */
export function cleanDataUrlForUpload(dataUrl: string): string {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(dataUrl);
  const mime = (m?.[1].split(';')[0] || '').toLowerCase();
  let bytes: Uint8Array;
  try {
    if (!m) throw new Error('not a data URL');
    bytes = m[2]
      ? Uint8Array.from(atob(m[3].replace(/\s+/g, '')), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch {
    throw new Error(shareBlockedMessage(mime || 'image/', 'unknown'));
  }
  const r = cleanForUpload(bytes, mime);
  if (!r.ok) throw new Error(r.message);
  return r.stripped ? `data:${mime || 'image/jpeg'};base64,${toBase64(r.bytes)}` : dataUrl;
}
