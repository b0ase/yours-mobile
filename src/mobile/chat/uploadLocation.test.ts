import { describe, expect, test } from 'bun:test';
import * as F from '../private/location.fixtures';
import { locationVerdict, shareBlockedMessage } from '../private/location';
import { BchatClient, type FormPart, type Http } from './api';
import { cleanDataUrlForUpload, cleanForUpload } from './uploadLocation';

/** b-Aware #288: a GPS-tagged chat photo went to bit-sign byte for byte (no location check on the chat path). */

const session = { token: 'T', handle: 'me', address: 'a' };
const b64 = (b: number[]) => btoa(String.fromCharCode(...b));

/** A signed-in client that records every multipart post and JSON call instead of sending it. */
const recorder = () => {
  const posts: FormPart[][] = [];
  const calls: { url: string; body: unknown }[] = [];
  const http: Http = async (req) => {
    calls.push({ url: req.url, body: req.body });
    return { status: 200, data: { avatar_url: 'https://x.test/a.jpg' } };
  };
  const client = new BchatClient(http, session, 'https://x.test');
  client.formPost = async (_url, _auth, parts) => {
    posts.push(parts);
    return { status: 200, data: { ok: true } };
  };
  return { client, posts, calls };
};

const sentBytes = async (parts: FormPart[]) => {
  const p = parts.find((x) => x.key === 'file');
  if (!p || !('file' in p)) throw new Error('no file part');
  return new Uint8Array(await p.file.arrayBuffer());
};

describe('chat room uploads: no location leaves the device', () => {
  test('a GPS photo (GPS in the Exif sub-IFD) is sent without its metadata, orientation kept', async () => {
    const { client, posts } = recorder();
    const photo = F.jpeg({ tiff: F.tiffGpsIn('exif', 6), xmp: 'gps' });
    const file = new File([F.u8(photo)], 'IMG_0001.jpg', { type: 'image/jpeg' });
    const sent = await client.uploadMedia('ROOM', file);
    expect(posts).toHaveLength(1);
    const bytes = await sentBytes(posts[0]);
    expect(locationVerdict(bytes, 'image/jpeg')).toBe('none');
    expect(bytes.length).toBeLessThan(photo.length);
    expect(bytes.some((_, i) => [1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6].every((x, j) => bytes[i + j] === x))).toBe(true);
    expect(posts[0][0]).toMatchObject({ key: 'file', fileName: 'IMG_0001.jpg' });
    expect(sent.type).toBe('image/jpeg');
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(bytes);
  });

  test('GPS in IFD0, IFD1 and SubIFDs: stripped as well', async () => {
    for (const t of [F.tiff(true), F.tiffGpsIn('ifd1'), F.tiffGpsIn('subifds'), F.tiffGpsIn('interop')]) {
      const { client, posts } = recorder();
      await client.uploadMedia('ROOM', new File([F.u8(F.jpeg({ tiff: t }))], 'p.jpg', { type: 'image/jpeg' }));
      expect(locationVerdict(await sentBytes(posts[0]), 'image/jpeg')).toBe('none');
    }
  });

  test('a located video, HEIC or PNG is refused before any request', async () => {
    for (const [bytes, mime] of [
      [F.mp4({ loc: 'keys' }), 'video/quicktime'],
      [F.heic({ gps: true }), 'image/heic'],
      [F.png([F.pngExif(true)]), 'image/png'],
      [F.mp4({ noMoov: true }), 'video/mp4'],
    ] as const) {
      const { client, posts } = recorder();
      const err = await client.uploadMedia('ROOM', new File([F.u8([...bytes])], 'x', { type: mime })).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(shareBlockedMessage(mime, locationVerdict(F.u8([...bytes]), mime)));
      expect(posts).toEqual([]);
    }
  });

  test('a JPEG that does not read through (may contain location) is refused, not sent', async () => {
    const { client, posts } = recorder();
    const cut = F.jpeg({ exif: 'gps' }).slice(0, 60);
    const err = await client
      .uploadMedia('ROOM', new File([F.u8(cut)], 'c.jpg', { type: 'image/jpeg' }))
      .catch((e) => e);
    expect((err as Error).message).toStartWith('This photo may contain location data');
    expect(posts).toEqual([]);
  });

  test('a clean photo, voice note or file goes as it is', async () => {
    for (const [bytes, mime] of [
      [F.jpeg({ exif: 'plain' }), 'image/jpeg'],
      [F.webm(false), 'audio/webm'],
      [F.ascii('hello'), 'text/plain'],
    ] as const) {
      const { client, posts } = recorder();
      const file = new File([F.u8([...bytes])], 'x', { type: mime });
      expect(await client.uploadMedia('ROOM', file)).toBe(file);
      expect(await sentBytes(posts[0])).toEqual(F.u8([...bytes]));
    }
  });
});

describe('my picture and room covers', () => {
  test('a GPS JPEG avatar is uploaded without metadata; a located WebP cover is refused', async () => {
    const { client, calls } = recorder();
    await client.uploadAvatar(`data:image/jpeg;base64,${b64(F.jpeg({ tiff: F.tiffGpsIn('subifds') }))}`);
    const sent = (calls[0].body as { avatar: string }).avatar;
    expect(sent.startsWith('data:image/jpeg;base64,')).toBe(true);
    const bytes = Uint8Array.from(atob(sent.split(',')[1]), (c) => c.charCodeAt(0));
    expect(locationVerdict(bytes, 'image/jpeg')).toBe('none');

    const err = await client
      .setRoomCover('ROOM', `data:image/webp;base64,${b64(F.webp({ exif: true }))}`)
      .catch((e) => e);
    expect((err as Error).message).toBe(shareBlockedMessage('image/webp'));
    expect(calls).toHaveLength(1);
    await client.setRoomCover('ROOM', null);
    expect(calls[1].body).toEqual({ dataUrl: null });
  });

  test('clean data URLs are untouched; one that does not decode is refused', () => {
    const clean = `data:image/png;base64,${b64(F.png())}`;
    expect(cleanDataUrlForUpload(clean)).toBe(clean);
    expect(() => cleanDataUrlForUpload('data:image/png;base64,%%%')).toThrow('may contain location data');
    expect(cleanForUpload(F.u8(F.gif(true)), 'image/gif')).toMatchObject({ ok: false });
  });
});
