import { describe, expect, test } from 'bun:test';
import * as F from '../private/location.fixtures';
import { locationVerdict, shareBlockedMessage } from '../private/location';
import { BchatClient, type FormPart, type Http } from './api';
import { cleanDataUrlForUpload, cleanForUpload, sendVoiceNote } from './uploadLocation';

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

  test('a GPS track video, a located PNG / WebP, an unreadable video: refused before any request', async () => {
    for (const [bytes, mime] of [
      [F.mp4({ loc: 'gpmd' }), 'video/mp4'],
      [F.png([F.pngExif(true)]), 'image/png'],
      [F.webp({ xmp: true }), 'image/webp'],
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

  test('phone videos and HEIC with location are sent with it blanked in place (same length), not refused', async () => {
    for (const [bytes, mime] of [
      [F.mp4({ loc: 'keys' }), 'video/quicktime'],
      [F.mp4({ loc: 'xyz' }), 'video/mp4'],
      [F.mp4({ loc: 'ffkeys' }), 'video/mp4'],
      [F.heic({ gps: true }), 'image/heic'],
      [F.heic({ gps: true, tiff: F.tiffGpsIn('exif', 6) }), 'image/heic'],
    ] as const) {
      const { client, posts } = recorder();
      const sent = await client.uploadMedia('ROOM', new File([F.u8([...bytes])], 'v', { type: mime }));
      const out = await sentBytes(posts[0]);
      expect([mime, locationVerdict(out, mime)]).toEqual([mime, 'none']);
      expect(out.length).toBe(bytes.length);
      expect(sent.type).toBe(mime);
    }
  });

  test('every JPEG goes without its metadata, even with no GPS found (UTF-16 XMP, IPTC city, comments)', async () => {
    const x16 = Array.from(F.xmp('exif:GPSLatitude="51,30.2N" exif:GPSLongitude="0,7.6W"')).flatMap((c) => [
      0,
      c.charCodeAt(0),
    ]);
    const photo = F.jpeg({
      exif: 'plain',
      app1: [[...F.ascii('http://ns.adobe.com/xap/1.0/\0'), ...x16]],
      extra: [F.jpegSeg(0xed, F.ascii('Photoshop 3.0\x008BIM London')), F.jpegSeg(0xfe, F.ascii('Home'))],
    });
    expect(locationVerdict(F.u8(photo), 'image/jpeg')).toBe('none');
    const { client, posts } = recorder();
    await client.uploadMedia('ROOM', new File([F.u8(photo)], 'p.jpg', { type: 'image/jpeg' }));
    const out = await sentBytes(posts[0]);
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toContain('London');
    expect(text).not.toContain('ns.adobe.com');
    expect(text).not.toContain('Home');
    expect(out.length).toBeLessThan(photo.length);
  });

  test("voice notes: audio that does not parse goes; the app recorder's file is never refused", async () => {
    const odd = [...F.mp4({ noMoov: true }).slice(0, 20), ...F.ascii('opus'), 1, 2, 3];
    let r = recorder();
    await r.client.uploadMedia('ROOM', new File([F.u8(odd)], 'voice.m4a', { type: 'audio/mp4' }));
    expect(await sentBytes(r.posts[0])).toEqual(F.u8(odd));
    // Location text the gate can't remove: refused from the file picker, sent from the recorder.
    const tagged = new File([F.u8(F.webm(true))], 'voice.webm', { type: 'audio/webm' });
    r = recorder();
    await expect(r.client.uploadMedia('ROOM', tagged)).rejects.toThrow('location data');
    expect(r.posts).toEqual([]);
    await sendVoiceNote(r.client, 'ROOM', tagged); // what the chat bar's voice note sheet calls
    expect(r.posts).toHaveLength(1);
  });

  test('a JPEG the stripper cannot read through is refused even with no GPS found (it would go with its metadata)', async () => {
    const cut = F.jpeg({ exif: 'plain', xmp: 'plain' }).slice(0, -2); // no EOI
    expect(locationVerdict(F.u8(cut), 'image/jpeg')).toBe('none');
    const { client, posts } = recorder();
    const err = await client
      .uploadMedia('ROOM', new File([F.u8(cut)], 'c.jpg', { type: 'image/jpeg' }))
      .catch((e) => e);
    expect((err as Error).message).toBe(shareBlockedMessage('image/jpeg', 'unknown'));
    expect(posts).toEqual([]);
  });

  test('a photo deck PDF is sent; a DJI-style subtitle-track video is refused', async () => {
    let r = recorder();
    const deck = F.u8(F.pdfWithPhotos(25));
    await r.client.uploadMedia('ROOM', new File([deck], 'deck.pdf', { type: 'application/pdf' }));
    expect(await sentBytes(r.posts[0])).toEqual(deck);
    r = recorder();
    const dji = F.u8(F.mp4({ tracks: ['avc1', 'tx3g'] }));
    const err = await r.client
      .uploadMedia('ROOM', new File([dji], 'DJI_0001.mp4', { type: 'video/mp4' }))
      .catch((e) => e);
    expect((err as Error).message).toBe(shareBlockedMessage('video/mp4', 'unknown'));
    expect(r.posts).toEqual([]);
  });

  test('a clean voice note or file goes as it is', async () => {
    for (const [bytes, mime] of [
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
