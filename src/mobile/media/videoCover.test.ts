import { describe, expect, test } from 'bun:test';
import { kindOf } from './media';
import { findMp4Cover } from './videoCover';
import { viewKind } from '../airdrops/nftView';

const box = (type: string, ...parts: Uint8Array[]) => {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set(new TextEncoder().encode(type), 4);
  let i = 8;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const cat = (...parts: Uint8Array[]) => box('xxxx', ...parts).slice(8);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const SVG = new TextEncoder().encode('<svg onload="x"/>');
const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\x02\0isomiso2'));
const mvhd = box('mvhd', new Uint8Array(100));
const coverMoov = (img: Uint8Array, iso = true) =>
  box(
    'moov',
    mvhd,
    box(
      'udta',
      box(
        'meta',
        ...(iso ? [new Uint8Array(4)] : []),
        box('hdlr', new Uint8Array(25)),
        box(
          'ilst',
          box('©nam', new Uint8Array(12)),
          box('covr', box('data', new Uint8Array([0, 0, 0, 13, 0, 0, 0, 0]), img)),
        ),
      ),
    ),
  );
const mdat = box('mdat', new Uint8Array(64));

describe('content type → preview kind', () => {
  test('viewer kinds: raster, video, audio, text; SVG and HTML never render', () => {
    expect(viewKind('video/mp4')).toBe('video');
    expect(viewKind('video/quicktime; codecs=x')).toBe('video');
    expect(viewKind('VIDEO/WEBM')).toBe('video');
    expect(viewKind('image/webp')).toBe('image');
    expect(viewKind('image/svg+xml')).toBe('other');
    expect(viewKind('text/html')).toBe('other');
    expect(viewKind('audio/mpeg')).toBe('audio');
    expect(viewKind(undefined)).toBe('other');
  });
  test('NFT grid kinds', () => {
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('image/png')).toBe('images');
  });
});

describe('MP4 cover (covr) detection', () => {
  test('finds a JPEG cover in a faststart MP4 (VexVoid clips)', () => {
    const r = findMp4Cover(cat(ftyp, coverMoov(JPEG), mdat));
    expect(r && r !== 'more' ? r.type : r).toBe('image/jpeg');
    expect(r && r !== 'more' ? [...r.bytes] : []).toEqual([...JPEG]);
  });
  test('PNG cover, and QuickTime meta without version/flags', () => {
    const r = findMp4Cover(cat(ftyp, coverMoov(PNG, false), mdat));
    expect(r && r !== 'more' ? r.type : r).toBe('image/png');
  });
  test('asks for more bytes while moov is incomplete', () => {
    const whole = cat(ftyp, coverMoov(JPEG), mdat);
    expect(findMp4Cover(whole.slice(0, 4))).toBe('more');
    expect(findMp4Cover(whole.slice(0, ftyp.length + 40))).toBe('more');
  });
  test('no cover, moov after mdat, non-MP4 or non-raster cover: null', () => {
    expect(findMp4Cover(cat(ftyp, box('moov', mvhd), mdat))).toBeNull();
    expect(findMp4Cover(cat(ftyp, mdat, coverMoov(JPEG)))).toBeNull();
    expect(findMp4Cover(new TextEncoder().encode('<html><body>hello</body></html>'))).toBeNull();
    expect(findMp4Cover(cat(ftyp, coverMoov(SVG), mdat))).toBeNull();
  });
});
