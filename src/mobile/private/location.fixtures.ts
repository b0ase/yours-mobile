/**
 * Tiny real files for the location detector's tests, built byte by byte: each format with and without location
 * metadata. Test-only (imported by location.test.ts and chat/uploadLocation.test.ts).
 */

type B = number[];

export const ascii = (s: string): B => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const be16 = (n: number): B => [(n >> 8) & 255, n & 255];
const be32 = (n: number): B => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = (n: number): B => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const cat = (...parts: B[]): B => parts.flat();
/** Deterministic filler that looks like compressed data. */
const noise = (n: number, seed = 7): B => {
  const out: B = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out.push((x >>> 16) & 255);
  }
  return out;
};
export const u8 = (b: B) => new Uint8Array(b);

// ── EXIF / TIFF ──────────────────────────────────────────────────────────────

/** Big-endian TIFF: IFD0 with Make (and the GPS IFD pointer, 0x8825), then a GPS IFD with a latitude ref. */
export function tiff(gps: boolean): B {
  const n = gps ? 2 : 1;
  const gpsAt = 8 + 2 + n * 12 + 4;
  const ifd0 = cat(
    be16(n),
    cat(be16(0x010f), be16(2), be32(4), ascii('Cam\0')),
    gps ? cat(be16(0x8825), be16(4), be32(1), be32(gpsAt)) : [],
    be32(0),
  );
  const gpsIfd = gps
    ? cat(be16(2), be16(0), be16(1), be32(4), [2, 3, 0, 0], be16(1), be16(2), be32(2), ascii('N\0\0\0'), be32(0))
    : [];
  return cat(ascii('MM'), be16(42), be32(8), ifd0, gpsIfd);
}

/** An IFD entry: tag, type, count, then an inline value or the IFD(s) it points at (indexes into the IFD list). */
export type Ent = [number, number, number, number | number[]];

/**
 * Big-endian TIFF from a list of IFDs (index 0 is IFD0) and IFD0's next link. Pointer lists longer than one go out
 * of line, after the IFDs.
 */
export function tiffIfds(ifds: Ent[][], ifd0Next = -1): B {
  const at: number[] = [];
  let o = 8;
  for (const e of ifds) {
    at.push(o);
    o += 2 + e.length * 12 + 4;
  }
  const extra: B = [];
  const value = ([, type, , v]: Ent): B => {
    if (typeof v === 'number') return type === 3 ? cat(be16(v), [0, 0]) : be32(v);
    if (v.length === 1) return be32(at[v[0]]);
    const out = be32(o + extra.length);
    extra.push(...v.flatMap((i) => be32(at[i])));
    return out;
  };
  const body = ifds.map((ents, k) =>
    cat(
      be16(ents.length),
      ...ents.map((e) => cat(be16(e[0]), be16(e[1]), be32(e[2]), value(e))),
      be32(k === 0 && ifd0Next >= 0 ? at[ifd0Next] : 0),
    ),
  );
  return cat(ascii('MM'), be16(42), be32(8), ...body, extra);
}

const GPS_IFD: Ent[] = [
  [0x0000, 1, 4, 0x02030000],
  [0x0001, 2, 2, 0x4e000000],
];
const EXIF_VERSION: Ent = [0x9000, 7, 4, 0x30323332];

/** A GPS IFD pointer outside IFD0 (b-Aware report 230): in the Exif IFD, the Interop IFD, IFD1 or one of the SubIFDs. */
export const tiffGpsIn = (where: 'exif' | 'interop' | 'ifd1' | 'subifds', orientation = 1): B =>
  where === 'exif'
    ? tiffIfds([
        [
          [0x0112, 3, 1, orientation],
          [0x8769, 4, 1, [1]],
        ],
        [EXIF_VERSION, [0x8825, 4, 1, [2]]],
        GPS_IFD,
      ])
    : where === 'interop'
      ? tiffIfds([
          [[0x8769, 4, 1, [1]]],
          [EXIF_VERSION, [0xa005, 4, 1, [2]]],
          [
            [0x0001, 2, 4, 0x52393800],
            [0x8825, 4, 1, [3]],
          ],
          GPS_IFD,
        ])
      : where === 'ifd1'
        ? tiffIfds(
            [
              [[0x0112, 3, 1, orientation]],
              [
                [0x0103, 3, 1, 6],
                [0x8825, 4, 1, [2]],
              ],
              GPS_IFD,
            ],
            1,
          )
        : tiffIfds([
            [[0x014a, 4, 2, [1, 2]]],
            [[0x0100, 3, 1, 8]],
            [
              [0x0100, 3, 1, 8],
              [0x8825, 4, 1, [3]],
            ],
            GPS_IFD,
          ]);

/** The same shapes without GPS: Exif + Interop IFDs, IFD1, two SubIFDs. */
export const tiffNoGps = (): B =>
  tiffIfds(
    [
      [
        [0x0112, 3, 1, 6],
        [0x014a, 4, 2, [2, 3]],
        [0x8769, 4, 1, [1]],
      ],
      [EXIF_VERSION, [0xa005, 4, 1, [4]]],
      [[0x0100, 3, 1, 8]],
      [[0x0100, 3, 1, 8]],
      [[0x0001, 2, 4, 0x52393800]],
      [[0x0103, 3, 1, 6]],
    ],
    5,
  );

// ── JPEG ─────────────────────────────────────────────────────────────────────

const seg = (marker: number, payload: B): B => cat([0xff, marker], be16(payload.length + 2), payload);
const XMP_NS = ascii('http://ns.adobe.com/xap/1.0/\0');
export const xmp = (body: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" ${body}/></rdf:RDF></x:xmpmeta>`;
const GPS_XMP = xmp('exif:GPSLatitude="51,30.4440N" exif:GPSLongitude="0,7.6680W"');
const PLAIN_XMP = xmp('exif:DateTimeOriginal="2026-11-05T10:00:00"');

/** Tables, a frame, a scan (with stuffed 0xFF00 bytes and a restart marker), more tables, a second scan, EOI. */
export const jpegBody = (): B =>
  cat(
    seg(0xdb, noise(65)),
    seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    seg(0xc4, noise(20, 5)),
    seg(0xda, [1, 1, 0, 0, 63, 0]),
    noise(100).map((x) => (x === 0xff ? 0x7f : x)),
    [0xff, 0x00, 0x12, 0xff, 0xd0, 0x34],
    noise(100, 9).map((x) => (x === 0xff ? 0x7f : x)),
    seg(0xc4, noise(20, 6)),
    seg(0xda, [1, 1, 0, 0, 63, 0]),
    noise(50, 11).map((x) => (x === 0xff ? 0x7f : x)),
    [0xff, 0xd9],
  );

export const jpeg = (
  o: {
    exif?: 'gps' | 'plain' | 'corrupt';
    tiff?: B;
    xmp?: 'gps' | 'plain';
    app1?: B[];
    extra?: B[];
    trailer?: B;
  } = {},
): B =>
  cat(
    [0xff, 0xd8],
    seg(0xe0, cat(ascii('JFIF\0'), [1, 1, 0, 0, 1, 0, 1, 0, 0])),
    o.exif === 'gps' ? seg(0xe1, cat(ascii('Exif\0\0'), tiff(true))) : [],
    o.exif === 'plain' ? seg(0xe1, cat(ascii('Exif\0\0'), tiff(false))) : [],
    o.exif === 'corrupt' ? seg(0xe1, cat(ascii('Exif\0\0'), ascii('XX'), noise(10))) : [],
    o.tiff ? seg(0xe1, cat(ascii('Exif\0\0'), o.tiff)) : [],
    o.xmp ? seg(0xe1, cat(XMP_NS, ascii(o.xmp === 'gps' ? GPS_XMP : PLAIN_XMP))) : [],
    ...(o.app1 ?? []).map((p) => seg(0xe1, p)),
    ...(o.extra ?? []),
    jpegBody(),
    o.trailer ?? [],
  );

/** Any marker segment (APPn, COM, …). */
export const jpegSeg = seg;

/**
 * Extended XMP (APP1 "http://ns.adobe.com/xmp/extension/"), as Pixel / Photoshop write it: one packet split over
 * parts, each with a GUID, the full length and its offset. The cut falls inside "GPSLatitude", so no part holds a
 * whole tag; `reversed` stores the parts out of order.
 */
export const extendedXmp = (reversed = false): B[] => {
  const text = ascii(
    '<x:xmpmeta><rdf:Description xmlns:e="http://ns.adobe.com/exif/1.0/" e:GPSLatitude="51,30N"/></x:xmpmeta>',
  );
  const cut = text.indexOf(ascii('L')[0], 50);
  const part = (off: number, end: number) =>
    cat(
      ascii('http://ns.adobe.com/xmp/extension/\0'),
      ascii('0123456789ABCDEF0123456789ABCDEF'),
      be32(text.length),
      be32(off),
      text.slice(off, end),
    );
  const parts = [part(0, cut), part(cut, text.length)];
  return reversed ? parts.reverse() : parts;
};

// ── PNG ──────────────────────────────────────────────────────────────────────

const chunk = (type: string, data: B): B => cat(be32(data.length), ascii(type), data, [0, 0, 0, 0]);
const IHDR = chunk('IHDR', cat(be32(1), be32(1), [8, 2, 0, 0, 0]));

export const png = (extra: B[] = []): B =>
  cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], IHDR, ...extra, chunk('IDAT', noise(30)), chunk('IEND', []));
export const pngExif = (gps: boolean) => chunk('eXIf', tiff(gps));
export const pngXmp = (gps: boolean, compressed = false) =>
  chunk(
    'iTXt',
    cat(
      ascii('XML:com.adobe.xmp\0'),
      [compressed ? 1 : 0, 0],
      [0],
      [0],
      compressed ? noise(40) : ascii(gps ? GPS_XMP : PLAIN_XMP),
    ),
  );
/** A PDF-like file with `n` embedded JPEGs (plain EXIF unless `gps`), as a photo deck exported to PDF. */
export const pdfWithPhotos = (n: number, o: { gps?: boolean; broken?: boolean } = {}): B =>
  cat(
    ascii('%PDF-1.4\n'),
    ...Array.from({ length: n }, (_, i) =>
      cat(
        ascii(`${i + 4} 0 obj<</Filter/DCTDecode>>stream\n`),
        jpeg({ exif: o.gps && i === n - 1 ? 'gps' : 'plain' }),
        ascii('\nendstream\n'),
      ),
    ),
    o.broken ? cat(ascii('Exif\0\0'), ascii('XX'), noise(10)) : [],
    ascii('%%EOF\n'),
  );

/** A tEXt chunk with any keyword and text. */
export const pngRawText = (keyword: string, text: string) => chunk('tEXt', ascii(`${keyword}\0${text}`));
/** ImageMagick also writes one tEXt per EXIF tag, keyword "exif:<Tag>". */
export const pngTagText = (tag: string, value: string) => chunk('tEXt', ascii(`exif:${tag}\0${value}`));
/** ImageMagick's hex "Raw profile type <kind>" tEXt chunk (exif by default; xmp carries the XMP packet). */
export const pngRawProfile = (gps: boolean, kind: 'exif' | 'xmp' = 'exif') => {
  const body = kind === 'xmp' ? ascii(gps ? GPS_XMP : PLAIN_XMP) : cat(ascii('Exif\0\0'), tiff(gps));
  const hex = body.map((x) => x.toString(16).padStart(2, '0')).join('');
  return chunk('tEXt', ascii(`Raw profile type ${kind}\0\n${kind}\n${String(body.length).padStart(8)}\n${hex}\n`));
};

// ── WebP ─────────────────────────────────────────────────────────────────────

const riffChunk = (type: string, data: B): B => cat(ascii(type), le32(data.length), data, data.length & 1 ? [0] : []);
export const webp = (o: { exif?: boolean; xmp?: boolean } = {}): B => {
  const body = cat(
    ascii('WEBP'),
    riffChunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    riffChunk('VP8 ', noise(41)),
    o.exif !== undefined ? riffChunk('EXIF', cat(ascii('Exif\0\0'), tiff(o.exif))) : [],
    o.xmp !== undefined ? riffChunk('XMP ', ascii(o.xmp ? GPS_XMP : PLAIN_XMP)) : [],
  );
  return cat(ascii('RIFF'), le32(body.length), body);
};

// ── ISO BMFF ─────────────────────────────────────────────────────────────────

const box = (type: string, payload: B): B => cat(be32(8 + payload.length), ascii(type), payload);
const full = (type: string, v: number, payload: B): B => box(type, cat([v, 0, 0, 0], payload));

/**
 * HEIC: ftyp, meta (hdlr, iinf with an hvc1 image item and an Exif item, iloc pointing into mdat), mdat. `prefixed`
 * puts "Exif\0\0" before the TIFF header (Apple); without it only the iinf / iloc reader can find the EXIF.
 */
export function heic(o: { gps: boolean; prefixed?: boolean; xmpGps?: boolean; tiff?: B }): B {
  const t = o.tiff ?? tiff(o.gps);
  const exifItem = o.prefixed ? cat(be32(6), ascii('Exif\0\0'), t) : cat(be32(0), t);
  const xmpItem = o.xmpGps === undefined ? [] : ascii(o.xmpGps ? GPS_XMP : PLAIN_XMP);
  const ftyp = box('ftyp', cat(ascii('heic'), be32(0), ascii('mif1heic')));
  const build = (exifOff: number, xmpOff: number) => {
    const infes = cat(
      full('infe', 2, cat(be16(1), be16(0), ascii('hvc1'), [0])),
      full('infe', 2, cat(be16(2), be16(0), ascii('Exif'), [0])),
      xmpItem.length ? full('infe', 2, cat(be16(3), be16(0), ascii('mime'), [0], ascii('application/rdf+xml\0'))) : [],
    );
    const count = xmpItem.length ? 3 : 2;
    const loc = (id: number, off: number, len: number) => cat(be16(id), be16(0), be16(1), be32(off), be32(len));
    const iloc = full(
      'iloc',
      0,
      cat(
        [0x44, 0x00],
        be16(count - 1),
        loc(2, exifOff, exifItem.length),
        xmpItem.length ? loc(3, xmpOff, xmpItem.length) : [],
      ),
    );
    return full(
      'meta',
      0,
      cat(
        full('hdlr', 0, cat(be32(0), ascii('pict'), new Array(13).fill(0))),
        full('iinf', 0, cat(be16(count), infes)),
        iloc,
      ),
    );
  };
  const metaLen = build(0, 0).length;
  const exifOff = ftyp.length + metaLen + 8;
  const meta = build(exifOff, exifOff + exifItem.length);
  return cat(ftyp, meta, box('mdat', cat(exifItem, xmpItem, noise(64))));
}

/**
 * MP4 / MOV: ftyp, moov (mvhd + optional udta ©xyz or Apple keys ISO6709), mdat. 'ffkeys' is ffmpeg's
 * use_metadata_tags form (a plain "location" mdta key, ISO 6709 value); 'gpmd' a GoPro-style GPS metadata track.
 */
export function mp4(
  o: {
    loc?: 'xyz' | 'keys' | 'ffkeys' | 'loci' | 'xmp' | 'gpmd';
    noMoov?: boolean;
    mdat?: B;
    /** Tracks by sample entry type ('avc1', 'mp4a', 'tx3g' subtitles, 'djmd' DJI telemetry…). */
    tracks?: string[];
    /** A udta comment (©cmt) with this text. */
    comment?: string;
    /** An Apple timed-metadata track ('mebx') with these key names. */
    mebxKeys?: string[];
  } = {},
): B {
  const ftyp = box('ftyp', cat(ascii('qt  '), be32(0), ascii('qt  isom')));
  const udta =
    o.loc === 'xyz'
      ? box('udta', box('\xA9xyz', cat(be16(18), be16(0x15c7), ascii('+51.5074-000.1278/'))))
      : o.loc === 'loci'
        ? box('udta', full('loci', 0, cat(be16(0x15c7), ascii('Home\0'), [0], noise(12))))
        : o.loc === 'xmp'
          ? box('udta', box('XMP_', ascii(GPS_XMP)))
          : [];
  const key = o.loc === 'keys' ? 'com.apple.quicktime.location.ISO6709' : 'location';
  const keys =
    o.loc === 'keys' || o.loc === 'ffkeys'
      ? box(
          'meta',
          cat(
            full('hdlr', 0, cat(be32(0), ascii('mdta'), new Array(13).fill(0))),
            full('keys', 0, cat(be32(2), box('mdta', ascii('title')), box('mdta', ascii(key)))),
            box(
              'ilst',
              cat(
                box('\0\0\0\x01', box('data', cat(be32(1), be32(0), ascii('Walk')))),
                box('\0\0\0\x02', box('data', cat(be32(1), be32(0), ascii('+51.5074-000.1278/')))),
              ),
            ),
          ),
        )
      : [];
  const gpmd = o.loc === 'gpmd' ? box('trak', box('mdia', box('minf', box('stbl', box('stsd', ascii('gpmd')))))) : [];
  const trak = (entry: string) =>
    box('trak', box('mdia', box('minf', box('stbl', full('stsd', 0, cat(be32(1), box(entry, noise(16))))))));
  const mebx = (keys: string[]) =>
    box(
      'mebx',
      cat(
        [0, 0, 0, 0, 0, 0, 0, 1],
        box(
          'keys',
          cat(...keys.map((k, i) => box(String.fromCharCode(0, 0, 0, i + 1), box('keyd', ascii(`mdta${k}`))))),
        ),
      ),
    );
  const mebxTrak = o.mebxKeys
    ? box('trak', box('mdia', box('minf', box('stbl', full('stsd', 0, cat(be32(1), mebx(o.mebxKeys)))))))
    : [];
  const tracks = [...(o.tracks ?? []).flatMap(trak), ...mebxTrak];
  const comment = o.comment ? box('udta', box('\xA9cmt', cat(be16(o.comment.length), be16(0), ascii(o.comment)))) : [];
  const moov = box('moov', cat(full('mvhd', 0, noise(96)), udta, keys, gpmd, tracks, comment));
  return cat(ftyp, o.noMoov ? [] : moov, box('mdat', o.mdat ?? noise(300)));
}

// ── others ───────────────────────────────────────────────────────────────────

export const gif = (gpsXmp: boolean): B =>
  cat(
    ascii('GIF89a'),
    [1, 0, 1, 0, 0, 0, 0],
    gpsXmp ? cat([0x21, 0xff, 11], ascii('XMP DataXMP'), ascii(GPS_XMP), [0]) : [],
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b],
  );

export const webm = (tagged: boolean): B =>
  cat(
    [0x1a, 0x45, 0xdf, 0xa3],
    noise(60),
    tagged ? cat(ascii('RECORDING_LOCATION'), ascii('+51.5-000.1/')) : [],
    noise(60, 3),
  );

export const ASCII_XYZ = ascii('\xA9xyz');
