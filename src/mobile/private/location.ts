/**
 * Location metadata detector (P0 privacy stopgap, CEO ruling 5 Nov 2026, bitcoin-corp
 * legal/RULING-2026-11-05-MINT-PRIVACY.md). Until location stripping ships, nothing that carries (or may carry) where
 * a photo or video was taken may be published: Reveal, a public mint and a feed post refuse it.
 *
 * Pure and dependency-free (no DOM, no Node APIs): the same file runs in bwalletx-indexer (src/location.ts).
 *
 * Verdicts:
 *   'found'   location metadata is there (EXIF GPS IFD, XMP GPS / geo, QuickTime ©xyz / ISO6709, 3GPP loci, …);
 *   'unknown' a format that can carry location which this parser could not read through: treat as "may contain";
 *   'none'    read through and nothing found.
 *
 * Covered: JPEG (EXIF APP1, XMP, MPF / trailing EXIF blocks), TIFF, PNG (eXIf, tEXt / iTXt XMP, ImageMagick raw
 * profiles), WebP (EXIF, XMP), GIF / SVG (XMP text), HEIC / HEIF / AVIF (Exif and XMP items via iinf / iloc),
 * MP4 / MOV / 3GP / M4A (©xyz, loci, com.apple.quicktime.location.ISO6709, XMP, GPS metadata tracks), WebM / MKV.
 */

export type LocationVerdict = 'none' | 'found' | 'unknown';

type Bytes = Uint8Array;

const enc = (s: string): Bytes => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const EXIF_HDR = enc('Exif\0\0');

/** XMP / text spellings of location (exif:GPS*, DJI drone-dji:Gps*, W3C geo, IPTC location, Apple ISO 6709). */
const TEXT_NEEDLES = [
  'exif:GPS',
  'GPSLatitude',
  'GPSLongitude',
  'GpsLatitude',
  'GpsLongitude',
  'GPSCoordinates',
  'wgs84_pos',
  'xmlns:geo',
  'geo:lat',
  'geo:long',
  'LocationCreated',
  'LocationShown',
  'ISO6709',
  'com.apple.quicktime.location',
].map(enc);

/** ISO BMFF / QuickTime (outside mdat): ©xyz, 3GPP loci, GoPro / Google camera-motion GPS tracks, dashcam gps box. */
const MOVIE_NEEDLES = [...TEXT_NEEDLES, enc('\xA9xyz'), enc('loci'), enc('gpmd'), enc('camm'), enc('gps ')];

/** Matroska / WebM tags. */
const MKV_NEEDLES = [...TEXT_NEEDLES, enc('LOCATION'), enc('RECORDING_LOCATION')];

const worst = (a: LocationVerdict, b: LocationVerdict): LocationVerdict =>
  a === 'found' || b === 'found' ? 'found' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'none';

function find(h: Bytes, n: Bytes, from = 0, to = h.length): number {
  const last = Math.min(to, h.length) - n.length;
  for (let i = h.indexOf(n[0], from); i !== -1 && i <= last; i = h.indexOf(n[0], i + 1)) {
    let j = 1;
    while (j < n.length && h[i + j] === n[j]) j++;
    if (j === n.length) return i;
  }
  return -1;
}

const anyNeedle = (b: Bytes, needles: Bytes[], from = 0, to = b.length) =>
  needles.some((n) => find(b, n, from, to) >= 0);

const textHasLocation = (b: Bytes, from = 0, to = b.length) => anyNeedle(b, TEXT_NEEDLES, from, to);

const startsWith = (b: Bytes, at: number, n: Bytes) => at + n.length <= b.length && n.every((x, i) => b[at + i] === x);

class Short extends Error {}
const need = (b: Bytes, at: number, len: number) => {
  if (at < 0 || at + len > b.length) throw new Short();
};
const u16 = (b: Bytes, o: number, le = false) => {
  need(b, o, 2);
  return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1];
};
const u32 = (b: Bytes, o: number, le = false) => {
  need(b, o, 4);
  return le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
};
const uN = (b: Bytes, o: number, size: number) => {
  if (size === 0) return 0;
  if (size === 2) return u16(b, o);
  if (size === 4) return u32(b, o);
  if (size === 8) return u32(b, o) * 2 ** 32 + u32(b, o + 4);
  throw new Short();
};
const ascii4 = (b: Bytes, o: number) => {
  need(b, o, 4);
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
};
const latin1 = (b: Bytes, s: number, e: number) => {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192)));
  return out;
};

// ── EXIF / TIFF ──────────────────────────────────────────────────────────────

/** A TIFF structure (EXIF body) starting at `o`: 'found' when IFD0 points to a GPS IFD (tag 0x8825). */
function tiffVerdict(b: Bytes, o: number, end = b.length): LocationVerdict {
  try {
    const t = b.subarray(o, Math.min(end, b.length));
    const le = t[0] === 0x49 && t[1] === 0x49;
    const be = t[0] === 0x4d && t[1] === 0x4d;
    if ((!le && !be) || u16(t, 2, le) !== 42) return 'unknown';
    const ifd = u32(t, 4, le);
    if (ifd < 8) return 'unknown';
    const n = u16(t, ifd, le);
    need(t, ifd + 2, n * 12);
    for (let i = 0; i < n; i++) if (u16(t, ifd + 2 + i * 12, le) === 0x8825) return 'found';
    return 'none';
  } catch {
    return 'unknown';
  }
}

/** An EXIF payload, with or without the "Exif\0\0" prefix. */
const exifVerdict = (b: Bytes, s: number, e = b.length) => tiffVerdict(b, startsWith(b, s, EXIF_HDR) ? s + 6 : s, e);

/** Every EXIF block anywhere in the file (embedded / MPF images, trailers) plus XMP text anywhere. */
function wholeFileScan(b: Bytes, from = 0, to = b.length): LocationVerdict {
  let v: LocationVerdict = 'none';
  for (let p = find(b, EXIF_HDR, from, to); p >= 0 && v !== 'found'; p = find(b, EXIF_HDR, p + 6, to))
    v = worst(v, tiffVerdict(b, p + 6));
  if (v !== 'found' && textHasLocation(b, from, to)) v = 'found';
  return v;
}

// ── image containers ─────────────────────────────────────────────────────────

/** JPEG: the marker segments must read through to SOS / EOI; EXIF itself is checked by wholeFileScan. */
function jpeg(b: Bytes): LocationVerdict {
  let i = 2;
  try {
    for (;;) {
      if (b[i] !== 0xff) return 'unknown';
      while (i < b.length && b[i] === 0xff) i++;
      need(b, i, 1);
      const m = b[i++];
      if (m === 0xd9 || m === 0xda) return 'none';
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;
      const len = u16(b, i);
      if (len < 2) return 'unknown';
      need(b, i, len);
      if (m === 0xe1 && startsWith(b, i + 2, EXIF_HDR) && tiffVerdict(b, i + 8, i + len) === 'unknown')
        return 'unknown';
      i += len;
    }
  } catch {
    return 'unknown';
  }
}

/** PNG chunks: eXIf, tEXt / zTXt / iTXt (XMP, ImageMagick "Raw profile type exif"). Must reach IEND. */
function png(b: Bytes): LocationVerdict {
  let v: LocationVerdict = 'none';
  let i = 8;
  try {
    for (;;) {
      const len = u32(b, i);
      const type = ascii4(b, i + 4);
      const s = i + 8;
      const e = s + len;
      need(b, s, len + 4);
      if (type === 'eXIf') v = worst(v, exifVerdict(b, s, e));
      else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') v = worst(v, pngText(b, type, s, e));
      if (v === 'found' || type === 'IEND') return v;
      i = e + 4;
    }
  } catch {
    return worst(v, 'unknown');
  }
}

function pngText(b: Bytes, type: string, s: number, e: number): LocationVerdict {
  const z = b.indexOf(0, s);
  if (z < 0 || z >= e) return 'unknown';
  const keyword = latin1(b, s, z).toLowerCase();
  const meta = /xmp|exif|app1|iptc|8bim/.test(keyword);
  const compressed = type === 'zTXt' || (type === 'iTXt' && b[z + 1] === 1);
  // The keyword too: ImageMagick writes one text chunk per EXIF tag ("exif:GPSLatitude").
  if (textHasLocation(b, s, z)) return 'found';
  // A compressed XMP / raw profile can't be read without inflating it: it may carry anything.
  if (compressed) return meta && !/^exif:/.test(keyword) ? 'unknown' : 'none';
  if (textHasLocation(b, z + 1, e)) return 'found';
  if (/^raw profile type (exif|app1)/.test(keyword)) return rawProfile(latin1(b, z + 1, e));
  return 'none';
}

/** ImageMagick raw profile: "\nexif\n   <len>\n<hex…>". */
function rawProfile(text: string): LocationVerdict {
  const m = /^\s*\S+\s+\d+\s+([0-9a-fA-F\s]+)$/.exec(text);
  if (!m) return 'unknown';
  const hex = m[1].replace(/\s+/g, '');
  if (hex.length % 2) return 'unknown';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const at = find(bytes, EXIF_HDR);
  return at >= 0 ? tiffVerdict(bytes, at + 6) : exifVerdict(bytes, 0);
}

/** WebP (RIFF): EXIF and "XMP " chunks. */
function webp(b: Bytes): LocationVerdict {
  let v: LocationVerdict = 'none';
  try {
    const end = Math.min(b.length, 8 + u32(b, 4, true));
    let i = 12;
    while (i + 8 <= end) {
      const type = ascii4(b, i);
      const len = u32(b, i + 4, true);
      const s = i + 8;
      if (s + len > end) return worst(v, 'unknown');
      if (type === 'EXIF') v = worst(v, exifVerdict(b, s, s + len));
      else if (type === 'XMP ' && textHasLocation(b, s, s + len)) v = 'found';
      if (v === 'found') return v;
      i = s + len + (len & 1);
    }
    return v;
  } catch {
    return worst(v, 'unknown');
  }
}

// ── ISO BMFF: HEIC / HEIF / AVIF, MP4 / MOV / 3GP / M4A ──────────────────────

type Box = { type: string; start: number; data: number; end: number };

/** The boxes in [s, e), or null when they don't tile it (truncated / corrupt). */
function boxes(b: Bytes, s: number, e: number): Box[] | null {
  const out: Box[] = [];
  let i = s;
  try {
    while (i + 8 <= e) {
      let size = u32(b, i);
      const type = ascii4(b, i + 4);
      let data = i + 8;
      if (size === 1) {
        size = uN(b, i + 8, 8);
        data = i + 16;
      } else if (size === 0) size = e - i;
      if (size < data - i || i + size > e) return null;
      out.push({ type, start: i, data, end: i + size });
      i += size;
    }
  } catch {
    return null;
  }
  // Up to 7 trailing zero bytes (padding) are fine; anything else is not a box.
  for (; i < e; i++) if (b[i] !== 0) return null;
  return out;
}

const MOVIE_FIRST_BOX = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'uuid', 'styp']);
const isBmff = (b: Bytes) => b.length >= 8 && MOVIE_FIRST_BOX.has(String.fromCharCode(b[4], b[5], b[6], b[7]));

function bmff(b: Bytes): LocationVerdict {
  const top = boxes(b, 0, b.length);
  if (!top) return 'unknown';
  const meta = top.find((x) => x.type === 'meta');
  const moov = top.find((x) => x.type === 'moov');
  if (!meta && !moov) return 'unknown';
  let v: LocationVerdict = 'none';
  // Everything but the media payload: udta / meta / keys / ilst / uuid (XMP) / sample descriptions.
  for (const x of top) if (x.type !== 'mdat' && anyNeedle(b, MOVIE_NEEDLES, x.start, x.end)) return 'found';
  if (meta) v = worst(v, heifItems(b, meta));
  // A still image (HEIC / AVIF): any other "Exif\0\0" block or XMP text in the item data too. (Not in meta, where an
  // infe's 'Exif' item type followed by its empty name reads as "Exif\0\0".)
  if (meta && !moov)
    for (const x of top) if (v !== 'found' && x.type === 'mdat') v = worst(v, wholeFileScan(b, x.data, x.end));
  return v;
}

/** HEIF meta: read every Exif item and XMP (mime …xml) item through iinf + iloc. */
function heifItems(b: Bytes, meta: Box): LocationVerdict {
  try {
    const kids = boxes(b, meta.data + 4, meta.end);
    if (!kids) return 'unknown';
    const iinf = kids.find((k) => k.type === 'iinf');
    if (!iinf) return 'none';
    const iv = b[iinf.data];
    const entries = boxes(b, iinf.data + 4 + (iv === 0 ? 2 : 4), iinf.end);
    if (!entries) return 'unknown';
    const wanted = new Map<number, 'exif' | 'xmp'>();
    for (const infe of entries.filter((x) => x.type === 'infe')) {
      const v = b[infe.data];
      let p = infe.data + 4;
      if (v >= 2) {
        const id = v === 2 ? u16(b, p) : u32(b, p);
        p += (v === 2 ? 2 : 4) + 2;
        const type = ascii4(b, p);
        p += 4;
        const z = b.indexOf(0, p);
        const contentType = type === 'mime' && z >= 0 && z < infe.end ? cString(b, z + 1, infe.end) : '';
        if (type === 'Exif') wanted.set(id, 'exif');
        else if (type === 'mime' && /xml|xmp/i.test(contentType)) wanted.set(id, 'xmp');
      } else {
        const id = u16(b, p);
        const z = b.indexOf(0, p + 4);
        const contentType = z >= 0 && z < infe.end ? cString(b, z + 1, infe.end) : '';
        if (/xml|xmp/i.test(contentType)) wanted.set(id, 'xmp');
        else if (/exif/i.test(contentType)) wanted.set(id, 'exif');
      }
    }
    if (!wanted.size) return 'none';
    const iloc = kids.find((k) => k.type === 'iloc');
    if (!iloc) return 'unknown';
    const idat = kids.find((k) => k.type === 'idat');
    const items = ilocItems(b, iloc);
    let out: LocationVerdict = 'none';
    for (const [id, kind] of wanted) {
      const it = items.get(id);
      if (!it) return 'unknown';
      const data = readItem(b, it, idat);
      if (!data) return 'unknown';
      if (kind === 'xmp') {
        if (textHasLocation(data)) return 'found';
        continue;
      }
      // Exif item: u32 offset to the TIFF header, then (usually) "Exif\0\0" + TIFF.
      let v = 'unknown' as LocationVerdict;
      if (data.length >= 4) v = exifVerdict(data, 4 + u32(data, 0));
      if (v === 'unknown') {
        const at = find(data, EXIF_HDR, 0, 64);
        if (at >= 0) v = tiffVerdict(data, at + 6);
      }
      out = worst(out, v);
      if (out === 'found') return out;
    }
    return out;
  } catch {
    return 'unknown';
  }
}

const cString = (b: Bytes, s: number, e: number) => {
  const z = b.indexOf(0, s);
  return latin1(b, s, z >= 0 && z < e ? z : e);
};

type IlocItem = { method: number; base: number; extents: { off: number; len: number }[] };

function ilocItems(b: Bytes, iloc: Box): Map<number, IlocItem> {
  const v = b[iloc.data];
  let p = iloc.data + 4;
  need(b, p, 2);
  const offSize = b[p] >> 4;
  const lenSize = b[p] & 15;
  const baseSize = b[p + 1] >> 4;
  const idxSize = v === 1 || v === 2 ? b[p + 1] & 15 : 0;
  p += 2;
  const count = v < 2 ? u16(b, p) : u32(b, p);
  p += v < 2 ? 2 : 4;
  const out = new Map<number, IlocItem>();
  for (let n = 0; n < count; n++) {
    const id = v < 2 ? u16(b, p) : u32(b, p);
    p += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) {
      method = u16(b, p) & 15;
      p += 2;
    }
    p += 2; // data_reference_index
    const base = uN(b, p, baseSize);
    p += baseSize;
    const ec = u16(b, p);
    p += 2;
    const extents: IlocItem['extents'] = [];
    for (let k = 0; k < ec; k++) {
      p += idxSize;
      const off = uN(b, p, offSize);
      p += offSize;
      const len = uN(b, p, lenSize);
      p += lenSize;
      extents.push({ off, len });
    }
    if (p > iloc.end) throw new Short();
    out.set(id, { method, base, extents });
  }
  return out;
}

function readItem(b: Bytes, it: IlocItem, idat: Box | undefined): Bytes | null {
  if (it.method > 1 || (it.method === 1 && !idat)) return null;
  const origin = it.method === 1 ? idat!.data : 0;
  const limit = it.method === 1 ? idat!.end : b.length;
  const parts: Bytes[] = [];
  for (const x of it.extents) {
    const s = origin + it.base + x.off;
    const e = x.len === 0 ? limit : s + x.len;
    if (s < origin || e > limit || s > e) return null;
    parts.push(b.subarray(s, e));
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

// ── entry point ──────────────────────────────────────────────────────────────

const magic = (b: Bytes, ...m: number[]) => b.length >= m.length && m.every((x, i) => b[i] === x);

/**
 * Does this file carry location metadata? Formats are recognised by their bytes, not the claimed type. A known
 * image / video container that doesn't read through is 'unknown' (may contain location). A file in a format this
 * parser doesn't know is 'unknown' when `mime` says image or video; any other file counts only on positive evidence.
 */
export function locationVerdict(input: Uint8Array | ArrayLike<number>, mime = ''): LocationVerdict {
  const b = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const visual = /^(image|video)\//i.test(mime.trim());
  let v: LocationVerdict | null = null;
  let still = false;
  if (magic(b, 0xff, 0xd8, 0xff)) [v, still] = [jpeg(b), true];
  else if (magic(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) [v, still] = [png(b), true];
  else if (magic(b, 0x52, 0x49, 0x46, 0x46) && b.length >= 12 && ascii4(b, 8) === 'WEBP') [v, still] = [webp(b), true];
  else if (magic(b, 0x47, 0x49, 0x46, 0x38)) [v, still] = ['none', true];
  else if (magic(b, 0x49, 0x49, 0x2a, 0x00) || magic(b, 0x4d, 0x4d, 0x00, 0x2a)) [v, still] = [tiffVerdict(b, 0), true];
  else if (magic(b, 0x42, 0x4d) && /bmp/i.test(mime)) [v, still] = ['none', true];
  else if (isBmff(b)) v = bmff(b);
  else if (magic(b, 0x1a, 0x45, 0xdf, 0xa3)) v = anyNeedle(b, MKV_NEEDLES) ? 'found' : 'none';
  else if (/svg|xml/i.test(mime)) [v, still] = ['none', true];
  if (v === null) {
    if (visual) return 'unknown';
    return textHasLocation(b) ? 'found' : 'none';
  }
  if (still && v !== 'found') v = worst(v, wholeFileScan(b));
  return v;
}

/** True when the file has, or may have, location metadata: block publishing it. */
export const hasLocationMetadata = (bytes: Uint8Array | ArrayLike<number>, mime: string): boolean =>
  locationVerdict(bytes, mime) !== 'none';

const noun = (mime: string) => (/^video\//i.test(mime) ? 'video' : /^image\//i.test(mime) ? 'photo' : 'file');
const has = (v: LocationVerdict) => (v === 'found' ? 'contains' : 'may contain');

/** Shown on Reveal of a blocked item. */
export const revealBlockedMessage = (mime: string, v: LocationVerdict = 'found') =>
  `This ${noun(mime)} ${has(v)} location data (where it was taken). Revealing it would publish that for good. ` +
  `Location removal is coming soon; until then this item can't be revealed.`;

/** Shown when "Make public now" is chosen for a file with location. */
export const publicMintBlockedMessage = (mime: string, v: LocationVerdict = 'found') =>
  `This ${noun(mime)} ${has(v)} location data (where it was taken). Minting it publicly would publish that for ` +
  `good. Location removal is coming soon; until then mint it privately.`;

/** Shown when a feed post would carry a file with location. */
export const postBlockedMessage = (mime: string, v: LocationVerdict = 'found') =>
  `This ${noun(mime)} ${has(v)} location data (where it was taken). Posting it would publish that for good. ` +
  `Location removal is coming soon; until then it can't be posted.`;

/** Informational line on a private mint (the mint is not blocked). */
export const privateMintLocationNote = (mime: string, v: LocationVerdict = 'found') =>
  `This ${noun(mime)} ${has(v)} location data; it stays encrypted, but would be published if you ever reveal it.`;

/** Thrown by revealMedia for an item with (possible) location metadata: nothing was sent. */
export class LocationBlockedError extends Error {
  // A plain field (no parameter property) so the file also runs under Node's type stripping.
  verdict: LocationVerdict;
  constructor(verdict: LocationVerdict, mime: string) {
    super(revealBlockedMessage(mime, verdict));
    this.name = 'LocationBlockedError';
    this.verdict = verdict;
  }
}
