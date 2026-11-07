import { describe, expect, test } from 'bun:test';
import { BchatClient, bytesToBase64, nativeFormData, parseGifResults, type FormPart, type Http } from './api';

const session = { token: 'T', handle: 'me', address: 'a' };

describe('room uploads (photos, files, voice notes)', () => {
  test('a small file is one multipart post with the bearer, field "file"', async () => {
    const posts: { url: string; auth: string; parts: FormPart[] }[] = [];
    const client = new BchatClient((async () => ({ status: 200, data: {} })) as Http, session, 'https://x.test');
    client.formPost = async (url, auth, parts) => {
      posts.push({ url, auth, parts });
      return { status: 200, data: { ok: true } };
    };
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    const progress: number[] = [];
    await client.uploadMedia('ROOM', file, (f) => progress.push(f));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://x.test/api/bitsign/rooms/ROOM/media');
    expect(posts[0].auth).toBe('Bearer T');
    expect(posts[0].parts).toHaveLength(1);
    expect(posts[0].parts[0]).toMatchObject({ key: 'file', fileName: 'pic.png' });
    expect(progress.at(-1)).toBe(1);
  });

  test('above 4 MB: 3 MB chunks, the last one names the file', async () => {
    const posts: { url: string; parts: FormPart[] }[] = [];
    const client = new BchatClient((async () => ({ status: 200, data: {} })) as Http, session, 'https://x.test');
    client.formPost = async (url, _auth, parts) => {
      posts.push({ url, parts });
      const last = parts.some((p) => p.key === 'filename');
      return { status: 200, data: last ? { assembled: true } : {} };
    };
    const file = new File([new Uint8Array(7 * 1024 * 1024)], 'clip.mp4', { type: 'video/mp4' });
    await client.uploadMedia('ROOM', file);
    expect(posts.map((p) => p.url.endsWith('/media/chunk'))).toEqual([true, true, true]);
    const last = posts[2].parts;
    expect(last.find((p) => p.key === 'filename')).toMatchObject({ value: 'clip.mp4' });
    expect(last.find((p) => p.key === 'mime')).toMatchObject({ value: 'video/mp4' });
  });

  test('a refusal surfaces the server reason', async () => {
    const client = new BchatClient((async () => ({ status: 200, data: {} })) as Http, session, 'https://x.test');
    client.formPost = async () => ({ status: 200, data: { skipped: [{ reason: 'Not a member' }] } });
    const file = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' });
    await expect(client.uploadMedia('ROOM', file)).rejects.toThrow('Not a member');
  });

  test('signed out: no request', async () => {
    let posted = false;
    const client = new BchatClient((async () => ({ status: 200, data: {} })) as Http, null, 'https://x.test');
    client.formPost = async () => {
      posted = true;
      return { status: 200, data: {} };
    };
    await expect(client.uploadMedia('ROOM', new File([new Uint8Array([1])], 'a.txt'))).rejects.toThrow();
    expect(posted).toBe(false);
  });
});

describe('phone apps: the multipart form for native HTTP', () => {
  test('strings stay strings; files become base64 with name and type', async () => {
    const out = await nativeFormData([
      { key: 'seq', value: '0' },
      { key: 'file', file: new Blob([new Uint8Array([104, 105])], { type: 'audio/mp4' }), fileName: 'v"o\nice.m4a' },
      { key: 'chunk', file: new Blob([new Uint8Array([0])]), fileName: 'x.part0' },
    ]);
    expect(out[0]).toEqual({ key: 'seq', type: 'string', value: '0' });
    expect(out[1]).toEqual({
      key: 'file',
      type: 'base64File',
      value: 'aGk=',
      fileName: 'v_o_ice.m4a',
      contentType: 'audio/mp4',
    });
    expect(out[2]).toMatchObject({ contentType: 'application/octet-stream', value: 'AA==' });
  });

  test('base64 of large buffers does not overflow the stack', () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 7).fill(65);
    const b64 = bytesToBase64(big);
    expect(b64.length).toBe(Math.ceil(big.length / 3) * 4);
    expect(b64.startsWith('QUFB')).toBe(true);
  });
});

describe('unfurl and GIF search go through the signed-in client', () => {
  test('unfurl asks bit-sign for the URL with the bearer', async () => {
    const seen: { url: string; auth?: string }[] = [];
    const http: Http = async (req) => {
      seen.push({ url: req.url, auth: req.headers.Authorization });
      return { status: 200, data: { previews: [] } };
    };
    const client = new BchatClient(http, session, 'https://x.test');
    await client.unfurl('https://terrornode.com/?a=1&b=2');
    expect(seen[0].url).toBe(
      `https://x.test/api/bitsign/unfurl?url=${encodeURIComponent('https://terrornode.com/?a=1&b=2')}`,
    );
    expect(seen[0].auth).toBe('Bearer T');
  });

  test('GIF results keep only https GIPHY URLs', () => {
    expect(
      parseGifResults({
        gifs: [
          {
            id: '1',
            preview: 'https://media1.giphy.com/media/a/200.gif',
            url: 'https://media1.giphy.com/media/a/giphy.gif',
          },
          { id: '2', preview: 'http://media1.giphy.com/x.gif', url: 'https://media1.giphy.com/x.gif' },
          { id: '3', preview: 'https://evil.example/x.gif', url: 'https://media1.giphy.com/x.gif' },
          { id: '4', preview: 'https://i.giphy.com/b.gif', url: 'javascript:alert(1)' },
          null,
        ],
      }),
    ).toEqual([
      {
        id: '1',
        preview: 'https://media1.giphy.com/media/a/200.gif',
        url: 'https://media1.giphy.com/media/a/giphy.gif',
      },
    ]);
    expect(parseGifResults(null)).toEqual([]);
  });
});
