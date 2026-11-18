import type { BchatClient } from './api';
import { blankBmffLocation, locationVerdict, shareBlockedMessage, stripJpegLocation } from '../private/location';

/**
 * The location gate for everything the wallet sends to bChat (b-Aware #288): room photos, videos, voice notes and
 * files (BchatClient.uploadMedia, which the chat bar, voice notes and commission clips all use), my picture and a
 * room cover. bit-sign keeps the bytes exactly as sent and serves them to every member, and any member can then
 * inscribe a room file publicly on chain (bit-sign rooms/[ticker]/media/[id]/stamp, mode 'full'). So nothing leaves
 * the device with location in it:
 *   - every JPEG goes without its metadata (private/location.ts stripJpegLocation, orientation kept), whatever the
 *     detector says: EXIF / XMP / IPTC also carry city names, maker notes and UTF-16 XMP it can't read. A JPEG the
 *     stripper can't read through (truncated, no EOI) is refused: it would go with all its metadata;
 *   - other files with no location found go as they are;
 *   - MOV / MP4 / M4A / HEIC with location have it blanked in place (blankBmffLocation), same length;
 *   - each changed copy is sent only if it then reads as clean;
 *   - the app's own MediaRecorder voice notes go as they are (other audio that doesn't parse is searched flat);
 *   - anything else with (possible) location is refused, nothing is sent.
 */
/**
 * ⚠ MediaRecorder output ONLY (sendVoiceNote below): the app's own microphone recording, which carries no location,
 * so the gate never refuses it. Never set it for a file the person picked, pasted or downloaded.
 */
export type MediaRecorderOnly = { mediaRecorderOutput?: true };

export type CleanUpload = { ok: true; bytes: Uint8Array; stripped: boolean } | { ok: false; message: string };

export function cleanForUpload(bytes: Uint8Array, mime: string, opts: MediaRecorderOnly = {}): CleanUpload {
  const v = locationVerdict(bytes, mime);
  if (isJpeg(bytes)) {
    const jpeg = stripJpegLocation(bytes);
    if (jpeg && locationVerdict(jpeg, 'image/jpeg') === 'none') return { ok: true, bytes: jpeg, stripped: true };
    return { ok: false, message: shareBlockedMessage(mime || 'image/jpeg', v === 'found' ? 'found' : 'unknown') };
  }
  if (v === 'none') return { ok: true, bytes, stripped: false };
  const blanked = blankBmffLocation(bytes);
  if (blanked && locationVerdict(blanked, mime) === 'none') return { ok: true, bytes: blanked, stripped: true };
  // A voice note from the app's recorder carries no location (MediaRecorder writes none). Other audio whose boxes
  // don't parse is already searched as a flat file by locationVerdict, so 'unknown' here means a telemetry track.
  if (opts.mediaRecorderOutput) return { ok: true, bytes, stripped: false };
  return { ok: false, message: shareBlockedMessage(mime, v) };
}

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** A File ready to send: the same one, or a cleaned copy. Throws the reason when it can't be sent. */
export async function cleanFileForUpload(file: File, opts: MediaRecorderOnly = {}): Promise<File> {
  const r = cleanForUpload(new Uint8Array(await file.arrayBuffer()), file.type, opts);
  if (!r.ok) throw new Error(r.message);
  if (!r.stripped) return file;
  return new File([r.bytes as BlobPart], file.name, {
    type: file.type || (isJpeg(r.bytes) ? 'image/jpeg' : ''),
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
  return r.stripped
    ? `data:${mime || (isJpeg(r.bytes) ? 'image/jpeg' : 'application/octet-stream')};base64,${toBase64(r.bytes)}`
    : dataUrl;
}

/** The chat bar's voice note: MediaRecorder output, so the gate runs with `mediaRecorderOutput` (never refused). */
export const sendVoiceNote = (client: Pick<BchatClient, 'uploadMedia'>, ticker: string, file: File) =>
  client.uploadMedia(ticker, file, undefined, { mediaRecorderOutput: true });
