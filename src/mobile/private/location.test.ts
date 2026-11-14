import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import * as F from './location.fixtures';
import {
  hasLocationMetadata,
  LocationBlockedError,
  locationVerdict,
  privateMintLocationNote,
  revealBlockedMessage,
  stripJpegLocation,
} from './location';
import type { PrivateItem } from './privateMint';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
const pm = await import('./privateMint');

const v = (b: number[], mime: string) => locationVerdict(F.u8(b), mime);

describe('locationVerdict: real tiny files', () => {
  test('JPEG: EXIF GPS IFD found, plain EXIF and no metadata pass', () => {
    expect(v(F.jpeg({ exif: 'gps' }), 'image/jpeg')).toBe('found');
    expect(v(F.jpeg({ exif: 'plain' }), 'image/jpeg')).toBe('none');
    expect(v(F.jpeg(), 'image/jpeg')).toBe('none');
  });

  test('JPEG: XMP exif:GPS* found, other XMP passes', () => {
    expect(v(F.jpeg({ xmp: 'gps' }), 'image/jpeg')).toBe('found');
    expect(v(F.jpeg({ xmp: 'plain' }), 'image/jpeg')).toBe('none');
  });

  test('JPEG: GPS in a second image after EOI (MPF) is found', () => {
    expect(v(F.jpeg({ exif: 'plain', trailer: F.jpeg({ exif: 'gps' }) }), 'image/jpeg')).toBe('found');
  });

  test('JPEG: unreadable EXIF or broken segments may contain location', () => {
    expect(v(F.jpeg({ exif: 'corrupt' }), 'image/jpeg')).toBe('unknown');
    const cut = F.jpeg({ exif: 'plain' }).slice(0, 30);
    expect(v(cut, 'image/jpeg')).toBe('unknown');
  });

  test('EXIF: a GPS pointer outside IFD0 is found (Exif IFD, Interop IFD, IFD1, SubIFDs; b-Aware #230)', () => {
    for (const where of ['exif', 'interop', 'ifd1', 'subifds'] as const) {
      expect([where, v(F.jpeg({ tiff: F.tiffGpsIn(where) }), 'image/jpeg')]).toEqual([where, 'found']);
      expect([where, v(F.tiffGpsIn(where), 'image/tiff')]).toEqual([where, 'found']);
    }
  });

  test('EXIF: every IFD walked with no GPS passes; a pointer that cannot be followed may contain location', () => {
    expect(v(F.jpeg({ tiff: F.tiffNoGps() }), 'image/jpeg')).toBe('none');
    expect(v(F.tiffNoGps(), 'image/tiff')).toBe('none');
    expect(v(F.jpeg({ tiff: F.tiffIfds([[[0x8769, 4, 1, 0x7fff]]]) }), 'image/jpeg')).toBe('unknown');
    expect(v(F.jpeg({ tiff: F.tiffIfds([[[0x8769, 4, 1, 0]]]) }), 'image/jpeg')).toBe('unknown');
    // An Exif IFD that points back at IFD0 (a loop) ends; GPS in the loop is still found.
    expect(v(F.jpeg({ tiff: F.tiffIfds([[[0x8769, 4, 1, [1]]], [[0x8769, 4, 1, [0]]]]) }), 'image/jpeg')).toBe('none');
    expect(
      v(
        F.jpeg({
          tiff: F.tiffIfds([
            [[0x8769, 4, 1, [1]]],
            [
              [0xa005, 4, 1, [0]],
              [0x8825, 4, 1, 0],
            ],
          ]),
        }),
        'image/jpeg',
      ),
    ).toBe('found');
  });

  test('JPEG: a loose "Exif\\0x" header or an unknown APP1 may contain location', () => {
    expect(v(F.jpeg({ app1: [[...F.ascii('Exif\0\xff'), ...F.tiff(true)]] }), 'image/jpeg')).toBe('unknown');
    expect(v(F.jpeg({ app1: [F.tiff(true)] }), 'image/jpeg')).toBe('unknown');
  });

  test('JPEG: extended XMP split over APP1 parts (a tag cut in two, parts out of order) is found', () => {
    expect(v(F.jpeg({ app1: F.extendedXmp() }), 'image/jpeg')).toBe('found');
    expect(v(F.jpeg({ app1: F.extendedXmp(true) }), 'image/jpeg')).toBe('found');
  });

  test('the claimed type does not matter for a recognised format', () => {
    expect(v(F.jpeg({ exif: 'gps' }), 'application/octet-stream')).toBe('found');
    expect(v(F.jpeg({ exif: 'gps' }), '')).toBe('found');
  });

  test('TIFF', () => {
    expect(v(F.tiff(true), 'image/tiff')).toBe('found');
    expect(v(F.tiff(false), 'image/tiff')).toBe('none');
  });

  test('PNG: eXIf, iTXt XMP, raw EXIF profile; compressed XMP may contain location', () => {
    expect(v(F.png([F.pngExif(true)]), 'image/png')).toBe('found');
    expect(v(F.png([F.pngExif(false)]), 'image/png')).toBe('none');
    expect(v(F.png([F.pngXmp(true)]), 'image/png')).toBe('found');
    expect(v(F.png([F.pngXmp(false)]), 'image/png')).toBe('none');
    expect(v(F.png([F.pngRawProfile(true)]), 'image/png')).toBe('found');
    expect(v(F.png([F.pngRawProfile(false)]), 'image/png')).toBe('none');
    expect(v(F.png([F.pngXmp(true, true)]), 'image/png')).toBe('unknown');
    expect(v(F.png([F.pngTagText('ColorSpace', '1'), F.pngTagText('ExifOffset', '26')]), 'image/png')).toBe('none');
    expect(v(F.png([F.pngTagText('GPSLatitude', '51/1, 30/1, 0/1')]), 'image/png')).toBe('found');
    expect(v(F.png(), 'image/png')).toBe('none');
    expect(v(F.png().slice(0, 40), 'image/png')).toBe('unknown');
  });

  test('WebP: EXIF and XMP chunks', () => {
    expect(v(F.webp({ exif: true }), 'image/webp')).toBe('found');
    expect(v(F.webp({ exif: false }), 'image/webp')).toBe('none');
    expect(v(F.webp({ xmp: true }), 'image/webp')).toBe('found');
    expect(v(F.webp({ xmp: false }), 'image/webp')).toBe('none');
    expect(v(F.webp(), 'image/webp')).toBe('none');
  });

  test('HEIC: Exif item through iinf / iloc (with and without the Exif prefix), XMP item', () => {
    expect(v(F.heic({ gps: true, prefixed: true }), 'image/heic')).toBe('found');
    expect(v(F.heic({ gps: true }), 'image/heic')).toBe('found');
    expect(v(F.heic({ gps: false }), 'image/heic')).toBe('none');
    expect(v(F.heic({ gps: false, prefixed: true }), 'image/heic')).toBe('none');
    expect(v(F.heic({ gps: false, xmpGps: true }), 'image/heic')).toBe('found');
    expect(v(F.heic({ gps: false, xmpGps: false }), 'image/heic')).toBe('none');
    const h = F.heic({ gps: false });
    expect(v(h.slice(0, h.length - 20), 'image/heic')).toBe('unknown');
  });

  test('MP4 / MOV: ©xyz, Apple ISO6709 key, 3GPP loci, XMP; mdat is not mistaken for metadata', () => {
    expect(v(F.mp4({ loc: 'xyz' }), 'video/mp4')).toBe('found');
    expect(v(F.mp4({ loc: 'keys' }), 'video/quicktime')).toBe('found');
    expect(v(F.mp4({ loc: 'loci' }), 'video/3gpp')).toBe('found');
    expect(v(F.mp4({ loc: 'xmp' }), 'video/mp4')).toBe('found');
    expect(v(F.mp4(), 'video/mp4')).toBe('none');
    expect(v(F.mp4({ mdat: [...F.ASCII_XYZ, ...F.ascii('loci ISO6709')] }), 'video/mp4')).toBe('none');
    expect(v(F.mp4({ loc: 'xyz' }), 'audio/mp4')).toBe('found');
  });

  test('MP4: no moov, or truncated, may contain location', () => {
    expect(v(F.mp4({ noMoov: true }), 'video/mp4')).toBe('unknown');
    const m = F.mp4();
    expect(v(m.slice(0, m.length - 10), 'video/mp4')).toBe('unknown');
  });

  test('GIF, WebM', () => {
    expect(v(F.gif(true), 'image/gif')).toBe('found');
    expect(v(F.gif(false), 'image/gif')).toBe('none');
    expect(v(F.webm(true), 'video/webm')).toBe('found');
    expect(v(F.webm(false), 'video/webm')).toBe('none');
  });

  test('an image / video format it cannot read may contain location; other files need evidence', () => {
    expect(v([1, 2, 3, 4, 5, 6, 7, 8, 9], 'image/x-unknown')).toBe('unknown');
    expect(v([1, 2, 3, 4, 5, 6, 7, 8, 9], 'video/x-msvideo')).toBe('unknown');
    expect(v(F.ascii('%PDF-1.7 hello'), 'application/pdf')).toBe('none');
    expect(hasLocationMetadata(F.u8(F.jpeg()), 'image/jpeg')).toBe(false);
    expect(hasLocationMetadata(F.u8(F.jpeg({ exif: 'gps' })), 'image/jpeg')).toBe(true);
  });

  test('messages', () => {
    expect(revealBlockedMessage('image/jpeg')).toBe(
      "This photo contains location data (where it was taken). Revealing it would publish that for good. Location removal is coming soon; until then this item can't be revealed.",
    );
    expect(revealBlockedMessage('video/mp4', 'unknown')).toStartWith('This video may contain location data');
    expect(privateMintLocationNote('image/heic')).toBe(
      'This photo contains location data; it stays encrypted, but would be published if you ever reveal it.',
    );
  });
});

// ── JPEG location removal ────────────────────────────────────────────────────

const hasSeq = (b: Uint8Array, seq: number[]) => b.some((_, i) => seq.every((x, j) => b[i + j] === x));

describe('stripJpegLocation', () => {
  test('drops EXIF (GPS in any IFD), XMP, extended XMP, comments, IPTC and trailing images; keeps the image', () => {
    const src = F.jpeg({
      tiff: F.tiffGpsIn('exif', 6),
      xmp: 'gps',
      app1: F.extendedXmp(),
      extra: [
        F.jpegSeg(0xfe, F.ascii('GPSLatitude 51.5')),
        F.jpegSeg(0xed, F.ascii('Photoshop 3.0\0 city')),
        F.jpegSeg(0xe2, F.ascii('ICC_PROFILE\0\x01\x01profile')),
      ],
      trailer: F.jpeg({ exif: 'gps' }),
    });
    expect(v(src, 'image/jpeg')).toBe('found');
    const out = stripJpegLocation(F.u8(src))!;
    expect(out).not.toBeNull();
    expect(locationVerdict(out, 'image/jpeg')).toBe('none');
    // SOI, the JFIF APP0 still first, then the one-entry EXIF with Orientation 6.
    expect([...out.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(hasSeq(out, [0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])).toBe(true);
    expect(hasSeq(out, F.ascii('ICC_PROFILE'))).toBe(true);
    expect(hasSeq(out, F.ascii('Photoshop'))).toBe(false);
    expect(hasSeq(out, F.ascii('xmpmeta'))).toBe(false);
    // Tables, frame and both scans byte for byte, ending at the first EOI (the trailing image is gone).
    const body = F.jpegBody();
    expect([...out.subarray(out.length - body.length)]).toEqual(body);
  });

  test('an upright or EXIF-less photo gets no EXIF back; GPS in IFD1 / SubIFDs is removed too', () => {
    for (const t of [F.tiffGpsIn('ifd1'), F.tiffGpsIn('subifds'), F.tiff(true)]) {
      const out = stripJpegLocation(F.u8(F.jpeg({ tiff: t })))!;
      expect(locationVerdict(out, 'image/jpeg')).toBe('none');
      expect(hasSeq(out, F.ascii('Exif'))).toBe(false);
    }
    expect(stripJpegLocation(F.u8(F.jpeg()))!.length).toBe(F.jpeg().length);
  });

  test('anything that does not read through to EOI is not "cleaned"', () => {
    const src = F.jpeg({ exif: 'gps' });
    expect(stripJpegLocation(F.u8(src.slice(0, src.length - 1)))).toBeNull();
    expect(stripJpegLocation(F.u8(src.slice(0, 40)))).toBeNull();
    expect(stripJpegLocation(F.u8(F.png([F.pngExif(true)])))).toBeNull();
  });
});

// ── Reveal ───────────────────────────────────────────────────────────────────

const item = (name: string, file: number[], mime = 'image/jpeg'): PrivateItem => ({
  outpoint: `${'ab'.repeat(32)}:${name.length}`,
  kid: 'cd'.repeat(16),
  header: { v: 1, kind: 'picture', mime, name, bytes: file.length, sha256: '', chunks: 1, chunk_size: 524288 },
  file: new Uint8Array(file),
});

/** A context whose wallet records (and refuses) every call: proves nothing was built or sent. */
const tripwire = () => {
  const calls: string[] = [];
  const wallet = new Proxy(
    {},
    {
      get: (_t, k) => {
        calls.push(String(k));
        return () => Promise.reject(new Error(`wallet.${String(k)} called`));
      },
    },
  );
  return { ctx: { wallet } as unknown as OneSatContext, calls };
};

describe('Reveal with location metadata', () => {
  test('revealMedia refuses a GPS photo before touching the wallet', async () => {
    const { ctx, calls } = tripwire();
    const err = await pm.revealMedia(ctx, item('home.jpg', F.jpeg({ exif: 'gps' }))).catch((e) => e);
    expect(err).toBeInstanceOf(LocationBlockedError);
    expect((err as Error).message).toBe(revealBlockedMessage('image/jpeg'));
    expect(calls).toEqual([]);
  });

  test('revealMedia refuses a located video and an unreadable one', async () => {
    const { ctx, calls } = tripwire();
    for (const it of [
      item('walk.mov', F.mp4({ loc: 'keys' }), 'video/quicktime'),
      item('odd.mp4', F.mp4({ noMoov: true }), 'video/mp4'),
    ]) {
      const err = await pm.revealMedia(ctx, it).catch((e) => e);
      expect(err).toBeInstanceOf(LocationBlockedError);
    }
    expect(calls).toEqual([]);
  });

  test('a clean photo is allowed through to the reveal (reaches the wallet)', async () => {
    const { ctx } = tripwire();
    const err = await pm.revealMedia(ctx, item('cat.jpg', F.jpeg({ exif: 'plain' }))).catch((e) => e);
    expect(err).not.toBeInstanceOf(LocationBlockedError);
    expect(pm.planReveal([item('cat.jpg', F.jpeg({ exif: 'plain' }))]).ok).toHaveLength(1);
  });

  test('"Reveal all" skips blocked items, lists them, reveals only the rest', async () => {
    const clean1 = item('a.jpg', F.jpeg());
    const gps = item('bb.jpg', F.jpeg({ exif: 'gps' }));
    const clean2 = item('ccc.png', F.png([F.pngExif(false)]), 'image/png');
    const heicGps = item('dddd.heic', F.heic({ gps: true }), 'image/heic');
    const plan = pm.planReveal([clean1, gps, clean2, heicGps]);
    expect(plan.ok.map((i) => i.header.name)).toEqual(['a.jpg', 'ccc.png']);
    expect(plan.blocked.map((b) => [b.item.header.name, b.verdict])).toEqual([
      ['bb.jpg', 'found'],
      ['dddd.heic', 'found'],
    ]);

    const sent: string[] = [];
    const progress: number[] = [];
    const { ctx } = tripwire();
    const res = await pm.revealMany(ctx, [clean1, gps, clean2, heicGps], {
      reveal: async (_c, it) => {
        sent.push(it.header.name);
        return { postTxid: 'ef'.repeat(32) };
      },
      onEach: (n) => progress.push(n),
    });
    expect(sent).toEqual(['a.jpg', 'ccc.png']);
    expect(progress).toEqual([1, 2]);
    expect(res.blocked.map((b) => b.item.header.name)).toEqual(['bb.jpg', 'dddd.heic']);
  });

  test('"Reveal all" stops part way with the count, nothing sent for blocked items', async () => {
    const { ctx } = tripwire();
    const sent: string[] = [];
    const err = await pm
      .revealMany(ctx, [item('a.jpg', F.jpeg()), item('x.jpg', F.jpeg({ xmp: 'gps' })), item('b.jpg', F.jpeg())], {
        reveal: async (_c, it) => {
          sent.push(it.header.name);
          if (it.header.name === 'b.jpg') throw new Error('network down');
          return { postTxid: 'ef'.repeat(32) };
        },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(pm.RevealStoppedError);
    expect([(err as InstanceType<typeof pm.RevealStoppedError>).done, err.total]).toEqual([1, 2]);
    expect(sent).toEqual(['a.jpg', 'b.jpg']);
  });

  test('all blocked: nothing is revealed', async () => {
    const sent: string[] = [];
    const { ctx } = tripwire();
    const res = await pm.revealMany(ctx, [item('x.jpg', F.jpeg({ exif: 'gps' }))], {
      reveal: async (_c, it) => {
        sent.push(it.header.name);
        return { postTxid: '' };
      },
    });
    expect(sent).toEqual([]);
    expect(res.revealed).toEqual([]);
  });
});
