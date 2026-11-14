/**
 * Location metadata detector (P0 privacy stopgap, CEO ruling 5 Nov 2026, bitcoin-corp
 * legal/RULING-2026-11-05-MINT-PRIVACY.md). Until location stripping ships, nothing that carries (or may carry) where
 * a photo or video was taken may be published: Reveal, a public mint and a feed post refuse it.
 *
 * Pure and dependency-free (no DOM, no Node APIs), so it can also run server-side. (No copy is in bwalletx-indexer
 * yet, despite earlier notes: checked 14 Nov 2026.)
 *
 * Chat (photos, videos, files, my picture, room covers) goes through chat/uploadLocation.ts: every JPEG has its
 * metadata removed by stripJpegLocation, MOV / MP4 / HEIC have their location blanked in place by blankBmffLocation,
 * anything else with (possible) location is refused (b-Aware #288).
 *
 * Verdicts:
 *   'found'   location metadata is there (EXIF GPS IFD, XMP GPS / geo, QuickTime ©xyz / ISO6709, 3GPP loci, …);
 *   'unknown' a format that can carry location which this parser could not read through: treat as "may contain";
 *   'none'    read through and nothing found.
 *
 * Covered: JPEG (EXIF APP1 with a GPS pointer in any IFD, XMP + extended XMP, MPF / trailing EXIF blocks), TIFF,
 * PNG (eXIf, tEXt / iTXt XMP, ImageMagick raw profiles of any type), WebP (EXIF, XMP), GIF / SVG (XMP text),
 * HEIC / HEIF / AVIF (Exif and XMP items via iinf / iloc), MP4 / MOV / 3GP / M4A (©xyz, loci, location mdta keys,
 * ISO 6709 values, XMP, GPS metadata tracks), WebM / MKV. Any other file: embedded EXIF blocks and location text.
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
  'GPSDest',
  'GPSAreaInformation',
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

/** A movie / audio file read as a flat byte string. */
const AUDIO_NEEDLES = [...TEXT_NEEDLES, enc('\xA9xyz')];

/**
 * An ISO 6709 coordinate as metadata stores it: decimal degrees ("+51.5033-000.1276/", Apple
 * "+37.3349-122.0090+010.000/"), or degrees + minutes (+ seconds) with the closing "/" ("+5130.20-00007.60/",
 * "+513012-0000736/").
 */
const ISO6709_RE =
  /[+-]\d{2}\.\d+[+-]\d{3}\.\d+|[+-]\d{2}(?:\d{2}){0,2}(?:\.\d+)?[+-]\d{3}(?:\d{2}){0,2}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS[\w:]*)?\//;
/** mdta key names with location in them: ffmpeg's plain "location", Apple's com.apple.quicktime.location.*. */
const MDTA_LOCATION_RE = /mdta[\x20-\x7e]{0,64}location/i;

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

/** Movie metadata (outside mdat) with location: the needles, an ISO 6709 value, or an mdta key named "…location…". */
function movieHasLocation(b: Bytes, s: number, e: number): boolean {
  if (anyNeedle(b, MOVIE_NEEDLES, s, e)) return true;
  const text = latin1(b, s, e);
  return ISO6709_RE.test(text) || MDTA_LOCATION_RE.test(text);
}

// ── EXIF / TIFF ──────────────────────────────────────────────────────────────

/** Tags whose value points at another IFD: Exif, Interoperability, SubIFDs (and any entry of type IFD, 13). */
const IFD_POINTER_TAGS = new Set([0x8769, 0xa005, 0x014a]);
/** More than any real file has (IFD0, IFD1, Exif, Interop, a few SubIFDs): past this it is a crafted file. */
const MAX_IFDS = 32;
const MAX_IFD_ENTRIES = 8192;

/**
 * A TIFF structure (EXIF body) starting at `o`: 'found' when ANY IFD in it has a GPS IFD pointer (tag 0x8825).
 * Every IFD is walked (IFD0 → IFD1 chain, Exif, Interoperability, SubIFDs, their next-IFD links): readers such as
 * exiftool decode a GPS pointer wherever it sits, and one in the Exif sub-IFD used to pass (b-Aware #230). An IFD
 * that is pointed at but can't be read is 'unknown'.
 */
function tiffVerdict(b: Bytes, o: number, end = b.length): LocationVerdict {
  try {
    const t = b.subarray(o, Math.min(end, b.length));
    const le = t[0] === 0x49 && t[1] === 0x49;
    const be = t[0] === 0x4d && t[1] === 0x4d;
    if ((!le && !be) || u16(t, 2, le) !== 42) return 'unknown';
    const todo = [u32(t, 4, le)];
    const seen = new Set<number>();
    let total = 0;
    while (todo.length) {
      const ifd = todo.pop()!;
      if (seen.has(ifd)) continue;
      if (ifd < 8 || seen.size >= MAX_IFDS) return 'unknown';
      seen.add(ifd);
      const n = u16(t, ifd, le);
      need(t, ifd + 2, n * 12 + 4);
      if ((total += n) > MAX_IFD_ENTRIES) return 'unknown';
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(t, e, le);
        if (tag === 0x8825) return 'found';
        if (IFD_POINTER_TAGS.has(tag) || u16(t, e + 2, le) === 13) todo.push(...ifdOffsets(t, e, le));
      }
      const next = u32(t, ifd + 2 + n * 12, le);
      if (next) todo.push(next);
    }
    return 'none';
  } catch {
    return 'unknown';
  }
}

/** The IFD offsets an entry points at: SHORT, LONG or IFD values, inline when they fit in 4 bytes. */
function ifdOffsets(t: Bytes, e: number, le: boolean): number[] {
  const type = u16(t, e + 2, le);
  const count = u32(t, e + 4, le);
  const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
  if (!size || count === 0 || count > MAX_IFDS) throw new Short();
  const at = count * size <= 4 ? e + 8 : u32(t, e + 8, le);
  need(t, at, count * size);
  return Array.from({ length: count }, (_, k) => (size === 2 ? u16(t, at + k * 2, le) : u32(t, at + k * 4, le)));
}

/** An EXIF payload, with or without the "Exif\0\0" prefix. */
const exifVerdict = (b: Bytes, s: number, e = b.length) => tiffVerdict(b, startsWith(b, s, EXIF_HDR) ? s + 6 : s, e);

/** Real files have a handful of EXIF blocks (main, thumbnail, MPF images); thousands are a stall attempt. */
const MAX_EXIF_BLOCKS = 64;

/** Every EXIF block anywhere in the file (embedded / MPF images, trailers) plus XMP text anywhere. */
function wholeFileScan(b: Bytes, from = 0, to = b.length): LocationVerdict {
  let v: LocationVerdict = 'none';
  let n = 0;
  for (let p = find(b, EXIF_HDR, from, to); p >= 0 && v !== 'found'; p = find(b, EXIF_HDR, p + 6, to)) {
    if (++n > MAX_EXIF_BLOCKS) {
      v = worst(v, 'unknown');
      break;
    }
    v = worst(v, tiffVerdict(b, p + 6));
  }
  if (v !== 'found' && textHasLocation(b, from, to)) v = 'found';
  return v;
}

// ── image containers ─────────────────────────────────────────────────────────

const XMP_NS = enc('http://ns.adobe.com/xap/1.0/\0');
const XMP_EXT_NS = enc('http://ns.adobe.com/xmp/extension/\0');
/** Extended XMP APP1: namespace, 32-byte GUID, u32 full length, u32 offset, then this part of the packet. */
const XMP_EXT_HEAD = XMP_EXT_NS.length + 32 + 8;

/**
 * JPEG: the marker segments must read through to SOS / EOI; EXIF itself is checked by wholeFileScan. An APP1 that is
 * not "Exif\0\0", XMP or extended XMP is 'unknown' (exiftool also reads a loose "Exif\0x" header). Extended XMP is
 * split over several APP1s, so its parts are joined in offset order before looking for GPS text (a tag could
 * straddle two).
 */
function jpeg(b: Bytes): LocationVerdict {
  let i = 2;
  const ext: { at: number; part: Bytes }[] = [];
  const done = (): LocationVerdict => {
    if (!ext.length) return 'none';
    ext.sort((x, y) => x.at - y.at);
    const all = new Uint8Array(ext.reduce((n, x) => n + x.part.length, 0));
    ext.reduce((o, x) => (all.set(x.part, o), o + x.part.length), 0);
    return textHasLocation(all) ? 'found' : 'none';
  };
  try {
    for (;;) {
      if (b[i] !== 0xff) return 'unknown';
      while (i < b.length && b[i] === 0xff) i++;
      need(b, i, 1);
      const m = b[i++];
      if (m === 0xd9 || m === 0xda) return done();
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;
      const len = u16(b, i);
      if (len < 2) return 'unknown';
      need(b, i, len);
      if (m === 0xe1) {
        if (startsWith(b, i + 2, EXIF_HDR)) {
          if (tiffVerdict(b, i + 8, i + len) === 'unknown') return 'unknown';
        } else if (startsWith(b, i + 2, XMP_EXT_NS)) {
          if (len < 2 + XMP_EXT_HEAD) return 'unknown';
          ext.push({ at: u32(b, i + 2 + XMP_EXT_HEAD - 4), part: b.subarray(i + 2 + XMP_EXT_HEAD, i + len) });
        } else if (!startsWith(b, i + 2, XMP_NS)) return 'unknown';
      }
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
  const raw = /^raw profile type (\S+)/.exec(keyword);
  if (raw) return rawProfile(latin1(b, z + 1, e), raw[1]);
  return 'none';
}

/**
 * ImageMagick raw profile: "\n<type>\n   <len>\n<hex…>". Every type is decoded (xmp, iptc, 8bim, exif, app1, …)
 * and searched for location text and EXIF blocks; one that doesn't decode may contain anything.
 */
function rawProfile(text: string, kind: string): LocationVerdict {
  const m = /^\s*\S+\s+\d+\s+([0-9a-fA-F\s]+)$/.exec(text);
  if (!m) return 'unknown';
  const hex = m[1].replace(/\s+/g, '');
  if (hex.length % 2) return 'unknown';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const v = wholeFileScan(bytes);
  // A bare TIFF (no "Exif\0\0" in front) in an EXIF profile.
  if (v === 'none' && /^(exif|app1)$/.test(kind) && find(bytes, EXIF_HDR) < 0) return exifVerdict(bytes, 0);
  return v;
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

/**
 * Sample entries of tracks whose samples (in mdat, never read here) can be text or vendor telemetry: subtitles
 * (DJI drones write "[latitude: …] [longitude: …]" per frame), timed text / metadata, DJI / GoPro / camera-motion
 * data. A movie with one of these may carry location. (Apple's 'mebx' metadata track is not here: every iPhone video
 * has one, and its keys sit in the sample description, which the needle scan reads.)
 */
const TEXT_SAMPLE_ENTRIES = new Set([
  'tx3g',
  'text',
  'wvtt',
  'sbtt',
  'stpp',
  'c608',
  'djmd',
  'dbgi',
  'camm',
  'gpmd',
  'mett',
  'metx',
  'rtmd',
]);

/** The sample entry types of every track (trak / mdia / minf / stbl / stsd), or null when a track doesn't read. */
function sampleEntryTypes(b: Bytes, moov: Box): string[] | null {
  const kids = (x: Box | undefined, at = 0) => (x ? boxes(b, x.data + at, x.end) : null);
  const pick = (list: Box[] | null, type: string) => list?.find((x) => x.type === type);
  const traks = kids(moov);
  if (!traks) return null;
  const out: string[] = [];
  for (const trak of traks.filter((x) => x.type === 'trak')) {
    const stbl = pick(kids(pick(kids(pick(kids(trak), 'mdia')), 'minf')), 'stbl');
    const entries = kids(pick(kids(stbl), 'stsd'), 8);
    if (!entries) return null;
    out.push(...entries.map((x) => x.type));
  }
  return out;
}

function bmff(b: Bytes): LocationVerdict {
  const top = boxes(b, 0, b.length);
  if (!top) return 'unknown';
  const meta = top.find((x) => x.type === 'meta');
  const moov = top.find((x) => x.type === 'moov');
  if (!meta && !moov) return 'unknown';
  let v: LocationVerdict = 'none';
  // Everything but the media payload: udta / meta / keys / ilst / uuid (XMP) / sample descriptions.
  for (const x of top) if (x.type !== 'mdat' && movieHasLocation(b, x.start, x.end)) return 'found';
  // Text / telemetry tracks keep their samples in mdat: may contain location.
  if (moov) {
    const entries = sampleEntryTypes(b, moov);
    if (!entries || entries.some((t) => TEXT_SAMPLE_ENTRIES.has(t))) return 'unknown';
  }
  if (meta) v = worst(v, heifItems(b, meta));
  // A still image (HEIC / AVIF): any other "Exif\0\0" block or XMP text in the item data too. (Not in meta, where an
  // infe's 'Exif' item type followed by its empty name reads as "Exif\0\0".)
  if (meta && !moov)
    for (const x of top) if (v !== 'found' && x.type === 'mdat') v = worst(v, wholeFileScan(b, x.data, x.end));
  return v;
}

/** A meta box's children: QuickTime's meta has none of the full-box version / flags in front of them, ISO's has. */
const metaKids = (b: Bytes, meta: Box) =>
  boxes(b, meta.data + (meta.data + 8 <= meta.end && ascii4(b, meta.data + 4) === 'hdlr' ? 0 : 4), meta.end);

/** An Exif or XMP item of a HEIF file; `data` null when it can't be read, `inPlace` when it is a view into the file. */
type HeifItem = { kind: 'exif' | 'xmp'; data: Bytes | null; inPlace: boolean };

/** HEIF meta: every Exif item and XMP (mime …xml) item through iinf + iloc. Null when the boxes can't be read. */
function heifMetaItems(b: Bytes, meta: Box): HeifItem[] | null {
  const kids = metaKids(b, meta);
  if (!kids) return null;
  const iinf = kids.find((k) => k.type === 'iinf');
  if (!iinf) return [];
  const iv = b[iinf.data];
  const entries = boxes(b, iinf.data + 4 + (iv === 0 ? 2 : 4), iinf.end);
  if (!entries) return null;
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
  if (!wanted.size) return [];
  const iloc = kids.find((k) => k.type === 'iloc');
  if (!iloc) return null;
  const idat = kids.find((k) => k.type === 'idat');
  const items = ilocItems(b, iloc);
  return [...wanted].map(([id, kind]) => {
    const it = items.get(id);
    return { kind, data: it ? readItem(b, it, idat) : null, inPlace: it?.extents.length === 1 };
  });
}

/** Where the TIFF header of an Exif item starts: u32 offset, then (usually) "Exif\0\0" + TIFF; else a search. */
function exifItemTiff(data: Bytes): number {
  if (data.length >= 8) {
    const at = 4 + u32(data, 0);
    const t = startsWith(data, at, EXIF_HDR) ? at + 6 : at;
    if (tiffVerdict(data, t) !== 'unknown') return t;
  }
  const at = find(data, EXIF_HDR, 0, 64);
  return at >= 0 ? at + 6 : -1;
}

/** HEIF meta: read every Exif item and XMP (mime …xml) item through iinf + iloc. */
function heifItems(b: Bytes, meta: Box): LocationVerdict {
  try {
    const items = heifMetaItems(b, meta);
    if (!items) return 'unknown';
    let out: LocationVerdict = 'none';
    for (const { kind, data } of items) {
      if (!data) return 'unknown';
      if (kind === 'xmp') {
        if (textHasLocation(data)) return 'found';
        continue;
      }
      const t = exifItemTiff(data);
      out = worst(out, t >= 0 ? tiffVerdict(data, t) : 'unknown');
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

// ── MOV / MP4 / HEIC: location blanked in place ──────────────────────────────

/** Bytes per value of each TIFF field type (1 BYTE … 13 IFD). */
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** Zero an IFD (count, entries, next link) and every value it keeps out of line. */
function zeroIfd(t: Bytes, ifd: number, le: boolean) {
  const n = u16(t, ifd, le);
  need(t, ifd + 2, n * 12 + 4);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const unit = TIFF_TYPE_SIZE[u16(t, e + 2, le)];
    if (!unit) throw new Short();
    const len = unit * u32(t, e + 4, le);
    if (len <= 4) continue;
    const at = u32(t, e + 8, le);
    need(t, at, len);
    t.fill(0, at, at + len);
  }
  t.fill(0, ifd, ifd + 2 + n * 12 + 4);
}

/**
 * Remove every GPS IFD from a TIFF structure, in place and at the same length: the GPS IFD and its values are zeroed,
 * and the 0x8825 entry pointing to it is taken out of its IFD (the later entries move up, the count drops by one, the
 * next link follows, the freed 12 bytes are zeroed), so the IFD stays sorted and valid. False when it can't be read.
 */
function blankTiffGps(t: Bytes): boolean {
  try {
    const le = t[0] === 0x49 && t[1] === 0x49;
    if ((!le && !(t[0] === 0x4d && t[1] === 0x4d)) || u16(t, 2, le) !== 42) return false;
    const todo = [u32(t, 4, le)];
    const seen = new Set<number>();
    while (todo.length) {
      const ifd = todo.pop()!;
      if (seen.has(ifd)) continue;
      if (ifd < 8 || seen.size >= MAX_IFDS) return false;
      seen.add(ifd);
      let n = u16(t, ifd, le);
      need(t, ifd + 2, n * 12 + 4);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(t, e, le);
        if (tag === 0x8825) {
          zeroIfd(t, u32(t, e + 8, le), le);
          const end = ifd + 2 + n * 12 + 4;
          t.copyWithin(e, e + 12, end);
          t.fill(0, end - 12, end);
          n--;
          t.set(le ? [n & 255, n >> 8] : [n >> 8, n & 255], ifd);
          i--;
        } else if (IFD_POINTER_TAGS.has(tag) || u16(t, e + 2, le) === 13) todo.push(...ifdOffsets(t, e, le));
      }
      const next = u32(t, ifd + 2 + n * 12, le);
      if (next) todo.push(next);
    }
    return true;
  } catch {
    return false;
  }
}

const FREE = enc('free');
/** A box becomes 'free' with a zeroed payload: same length, so chunk offsets (stco / co64, iloc) stay valid. */
const freeBox = (b: Bytes, x: Box) => {
  b.set(FREE, x.start + 4);
  b.fill(0, x.data, x.end);
};

/** QuickTime / 3GPP location atoms, and boxes that hold XMP text. */
const LOCATION_ATOMS = new Set(['\xA9xyz', 'loci', 'XMP_', 'uuid']);

/**
 * moov / trak / udta: location atoms, XMP with location and (in udta, where every child is a metadata atom) any atom
 * with a location value become 'free'; meta boxes go to blankMeta.
 */
function blankMovie(b: Bytes, s: number, e: number, udta = false): boolean {
  const kids = boxes(b, s, e);
  if (!kids) return false;
  for (const x of kids) {
    if (x.type === 'mdat' || !movieHasLocation(b, x.start, x.end)) continue;
    if (LOCATION_ATOMS.has(x.type) || (udta && x.type !== 'meta')) freeBox(b, x);
    else if (x.type === 'meta') {
      if (!blankMeta(b, x)) return false;
    } else if (x.type === 'moov' || x.type === 'trak' || x.type === 'udta') {
      if (!blankMovie(b, x.data, x.end, x.type === 'udta')) return false;
    }
    // Anything else with location (a GoPro / camm GPS track) stays: the re-check then refuses the file.
  }
  return true;
}

/**
 * A meta box: Apple keys + ilst (com.apple.quicktime.location.*: the key name is zeroed, its ilst item becomes
 * 'free'), iTunes-style ilst items (©xyz), and HEIF Exif / XMP items (GPS IFDs removed, XMP with location blanked
 * to spaces). False when something with location can't be blanked in place.
 */
function blankMeta(b: Bytes, meta: Box): boolean {
  const kids = metaKids(b, meta);
  if (!kids) return false;
  const gone = new Set<number>();
  const keys = kids.find((k) => k.type === 'keys');
  if (keys) {
    let p = keys.data + 8;
    for (let k = 1, count = u32(b, keys.data + 4); k <= count; k++) {
      const size = u32(b, p);
      if (size < 8 || p + size > keys.end) return false;
      if (textHasLocation(b, p + 8, p + size) || /location/i.test(latin1(b, p + 8, p + size))) {
        b.fill(0, p + 8, p + size);
        gone.add(k);
      }
      p += size;
    }
  }
  const ilst = kids.find((k) => k.type === 'ilst');
  if (ilst) {
    const items = boxes(b, ilst.data, ilst.end);
    if (!items) return false;
    for (const it of items)
      if (gone.has(u32(b, it.start + 4)) || LOCATION_ATOMS.has(it.type) || movieHasLocation(b, it.start, it.end))
        freeBox(b, it);
  }
  for (const x of kids) if (LOCATION_ATOMS.has(x.type) && movieHasLocation(b, x.start, x.end)) freeBox(b, x);
  const items = heifMetaItems(b, meta);
  if (!items) return false;
  for (const { kind, data, inPlace } of items) {
    if (!data) return false;
    if (kind === 'xmp') {
      if (!textHasLocation(data)) continue;
      if (!inPlace) return false;
      data.fill(0x20);
      continue;
    }
    const t = exifItemTiff(data);
    if (t < 0) return false;
    if (tiffVerdict(data, t) === 'none') continue;
    if (!inPlace || !blankTiffGps(data.subarray(t))) return false;
  }
  return true;
}

/**
 * A copy of a MOV / MP4 / 3GP / M4A / HEIC file with its location blanked in place (same length, every offset still
 * valid): QuickTime ©xyz, 3GPP loci, Apple com.apple.quicktime.location.* keys, XMP with location, and the GPS IFD of
 * HEIF Exif items. Null when the boxes don't read. Callers run locationVerdict on the result and send it only when
 * that says 'none' (a GPS metadata track, for one, is not blanked and so still refuses).
 */
export function blankBmffLocation(input: Uint8Array): Uint8Array | null {
  if (!isBmff(input)) return null;
  const b = input.slice();
  try {
    const top = boxes(b, 0, b.length);
    if (!top) return null;
    for (const x of top) {
      if (x.type === 'mdat') continue;
      if (x.type === 'meta') {
        if (!blankMeta(b, x)) return null;
      } else if (movieHasLocation(b, x.start, x.end)) {
        if (x.type === 'uuid') freeBox(b, x);
        else if (x.type === 'moov' || x.type === 'udta') {
          if (!blankMovie(b, x.data, x.end, x.type === 'udta')) return null;
        }
      }
    }
    return b;
  } catch {
    return null;
  }
}

// ── JPEG location removal ────────────────────────────────────────────────────

const JFIF = enc('JFIF\0');
const ICC = enc('ICC_PROFILE\0');
const ADOBE = enc('Adobe');

/** EXIF Orientation (IFD0 tag 0x0112) from the TIFF at `o`, or 0 when absent, upright or unreadable. */
function orientationOf(b: Bytes, o: number, end: number): number {
  try {
    const t = b.subarray(o, end);
    const le = t[0] === 0x49 && t[1] === 0x49;
    const ifd = u32(t, 4, le);
    const n = u16(t, ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(t, e, le) !== 0x0112 || u16(t, e + 2, le) !== 3) continue;
      const v = u16(t, e + 8, le);
      return v >= 2 && v <= 8 ? v : 0;
    }
  } catch {
    /* no orientation */
  }
  return 0;
}

/** A minimal EXIF APP1 carrying only the Orientation, so a phone photo still shows the right way up. */
const orientationApp1 = (v: number): Bytes =>
  Uint8Array.from([
    0xff,
    0xe1,
    0,
    34,
    ...EXIF_HDR,
    0x4d,
    0x4d,
    0,
    42,
    0,
    0,
    0,
    8,
    0,
    1,
    1,
    0x12,
    0,
    3,
    0,
    0,
    0,
    1,
    0,
    v,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);

/**
 * A copy of a JPEG with its metadata removed, or null when it doesn't read through cleanly (then refuse it). Kept:
 * the image segments (tables, frame, scans, restarts), a JFIF APP0, the ICC colour profile (APP2) and Adobe's APP14
 * colour transform. Dropped: every other APPn (EXIF with its GPS IFD and thumbnail, XMP, extended XMP, IPTC /
 * Photoshop, MPF), comments, and anything after EOI (MPF / gain-map images). The EXIF Orientation is written back as
 * a one-entry EXIF block. Callers still run locationVerdict on the result and send it only when that says 'none'.
 */
export function stripJpegLocation(input: Uint8Array): Uint8Array | null {
  const b = input;
  if (!magic(b, 0xff, 0xd8, 0xff)) return null;
  const kept: Bytes[] = [];
  let app0 = 0; // leading JFIF APP0 segments, which stay first
  let orientation = 0;
  let scans = 0;
  let i = 2;
  try {
    for (;;) {
      // Stray bytes between segments (some cameras) are skipped to the next marker, as libjpeg does.
      if (b[i] !== 0xff) i = b.indexOf(0xff, i);
      if (i < 0) return null;
      while (i < b.length && b[i] === 0xff) i++;
      need(b, i, 1);
      const m = b[i++];
      const s = i - 2;
      if (m === 0xd9) {
        kept.push(b.subarray(s, i));
        break;
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        kept.push(b.subarray(s, i));
        continue;
      }
      if (m === 0x00 || m === 0xd8) return null;
      const len = u16(b, i);
      if (len < 2) return null;
      need(b, i, len);
      let e = i + len;
      if (m === 0xda) {
        // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart.
        scans++;
        for (;;) {
          const ff = b.indexOf(0xff, e);
          if (ff < 0 || ff + 1 >= b.length) return null;
          const x = b[ff + 1];
          e = ff + (x === 0 || (x >= 0xd0 && x <= 0xd7) ? 2 : 0);
          if (e === ff) break;
        }
      }
      const at = i + 2;
      if (m === 0xe1 && !orientation && startsWith(b, at, EXIF_HDR)) orientation = orientationOf(b, at + 6, i + len);
      const keep =
        m >= 0xe0 && m <= 0xef
          ? (m === 0xe0 && startsWith(b, at, JFIF)) ||
            (m === 0xe2 && startsWith(b, at, ICC)) ||
            (m === 0xee && startsWith(b, at, ADOBE))
          : m !== 0xfe;
      if (keep) {
        if (m === 0xe0 && app0 === kept.length) app0++;
        kept.push(b.subarray(s, e));
      }
      i = e;
    }
  } catch {
    return null;
  }
  if (!scans) return null;
  const parts = [b.subarray(0, 2), ...kept.slice(0, app0), ...(orientation ? [orientationApp1(orientation)] : [])];
  parts.push(...kept.slice(app0));
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  parts.reduce((o, x) => (out.set(x, o), o + x.length), 0);
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
  else if (isBmff(b)) {
    v = bmff(b);
    // Audio whose boxes don't read through (a recorder's fragmented MP4): look for location anywhere instead of
    // refusing it outright (only the longer, text needles: short atom names turn up by chance in audio data).
    if (v === 'unknown' && /^audio\//i.test(mime.trim()))
      v = anyNeedle(b, AUDIO_NEEDLES) || ISO6709_RE.test(latin1(b, 0, b.length)) ? 'found' : 'none';
  } else if (magic(b, 0x1a, 0x45, 0xdf, 0xa3)) v = anyNeedle(b, MKV_NEEDLES) ? 'found' : 'none';
  else if (/svg|xml/i.test(mime)) [v, still] = ['none', true];
  if (v === null) {
    if (visual) return 'unknown';
    // Any other file (a PDF, a RAW sent as octet-stream, a zip): GPS EXIF of an embedded photo, or location text.
    // Only positive evidence counts: a deck of many photos, or an EXIF block that doesn't parse, is not refused.
    return wholeFileScan(b) === 'found' ? 'found' : 'none';
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

/** Shown when a chat photo / video / file, my picture or a room cover would carry location (it is not sent). */
export const shareBlockedMessage = (mime: string, v: LocationVerdict = 'found') =>
  `This ${noun(mime)} ${has(v)} location data (where it was taken). Sending it would share that with everyone who ` +
  `sees it. Location removal for this kind of file is coming soon; until then it can't be sent.`;

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
