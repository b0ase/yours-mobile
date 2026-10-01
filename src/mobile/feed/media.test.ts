import { describe, expect, test } from 'bun:test';
import { SafetyFilter, normalizeBlocklist } from '../market/safety';
import {
  dedupeMedia,
  kindOf,
  linkEmbed,
  mediaFromB,
  mediaFromMap,
  mediaFromText,
  mediaSafety,
  planAv,
  refToOutpoint,
  MAX_INLINE_AV_BYTES,
  MAX_INSCRIBED_AV_BYTES,
} from './media';
import { buildPostScript, decodeScript, parseBmapPost, parseTwetchFeed, validatePost } from './post';
import { visiblePosts } from './store';

const T = 'ffff74b706aec8f2f1dbe1257cf3b1920a246339adbfd928ce5e7fdf6a7130af';
const OP = 'a7ccd6b9aac6309b59287e7dd0592e5f06ebd86a732853e763b3388736825597_0';

describe('refToOutpoint', () => {
  test('on-chain ref forms', () => {
    expect(refToOutpoint(`b://${T}`)).toBe(`${T}_0`);
    expect(refToOutpoint(`1sat://${T}_3`)).toBe(`${T}_3`);
    expect(refToOutpoint(`ord://${T}.2`)).toBe(`${T}_2`);
    expect(refToOutpoint(`bitfs://${T}.out.1.3`)).toBe(`${T}_1`);
    expect(refToOutpoint(T.toUpperCase())).toBe(`${T}_0`);
    expect(refToOutpoint(OP)).toBe(OP);
  });
  test('content-host URLs (live Treechat patterns)', () => {
    expect(refToOutpoint(`https://3dordi.io/ordinal/${OP}`)).toBe(OP);
    expect(refToOutpoint(`https://ordfs.network/content/${OP}`)).toBe(OP);
    expect(refToOutpoint(`https://ordfs.network/${T}`)).toBe(`${T}_0`);
    expect(refToOutpoint(`https://api.1sat.app/content/${OP}`)).toBe(OP);
  });
  test('rejects lookalikes', () => {
    expect(refToOutpoint(`https://evil.example/${OP}`)).toBeNull();
    expect(refToOutpoint(`b://${T}x`)).toBeNull();
    expect(refToOutpoint('javascript:alert(1)')).toBeNull();
  });
});

test('kindOf', () => {
  expect(kindOf('image/webp')).toBe('image');
  expect(kindOf('video/quicktime')).toBe('video');
  expect(kindOf('video/webm')).toBe('video');
  expect(kindOf('audio/mpeg')).toBe('audio');
  expect(kindOf('audio/wav')).toBe('audio');
  expect(kindOf('image/svg+xml')).toBeNull();
  expect(kindOf('text/html')).toBeNull();
});

describe('mediaFromB', () => {
  test('inline base64 → data URI', () => {
    const m = mediaFromB({ mime: 'image/jpeg', content: '/9j/4AAQSkZJRgABAQAAAQABAAD' }, T, 1)!;
    expect(m.src.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(m.kind).toBe('image');
  });
  test('Twetch: content stripped by bmap → ordfs <txid>_0 with a resized thumb', () => {
    const m = mediaFromB({ mime: 'image/jpeg', content: '', filename: 'twetch_twembed1.jpg' }, T, 0)!;
    expect(m.src).toBe(`https://ordfs.network/${T}_0`);
    expect(m.thumb).toContain(`/ordfs/image/${T}_0?`);
    expect(m.ref).toBe(`${T}_0`);
    const v = mediaFromB({ mime: 'video/mp4', content: '' }, T, 0)!;
    expect(v.kind).toBe('video');
    expect(v.thumb).toBeNull();
    // Later stripped parts are not addressable.
    expect(mediaFromB({ mime: 'image/jpeg', content: '' }, T, 1)).toBeNull();
  });
  test('b:// reference and https URL', () => {
    expect(mediaFromB({ mime: 'audio/mpeg', content: `b://${T}` }, T, 1)!.src).toBe(`https://ordfs.network/${T}_0`);
    expect(mediaFromB({ mime: 'video/mp4', content: 'https://x.example/a.mp4' }, T, 1)!.src).toBe(
      'https://x.example/a.mp4',
    );
    expect(mediaFromB({ mime: 'video/mp4', content: 'http://x.example/a.mp4' }, T, 1)).toBeNull();
    expect(mediaFromB({ mime: 'application/pdf', content: 'AAAAAAAAAAAAAAAAAAAAAA' }, T, 1)).toBeNull();
  });
});

describe('mediaFromText', () => {
  test('Treechat 3dordi ordinal link + YouTube', () => {
    const r = mediaFromText(`"Too Soft" -https://3dordi.io/ordinal/${OP} \r\nhttps://youtu.be/m8dMy5_Lox4 @x`);
    expect(r.media).toHaveLength(1);
    expect(r.media[0]).toMatchObject({ kind: 'image', ref: OP, guessed: true });
    expect(r.links).toEqual([
      {
        kind: 'youtube',
        id: 'm8dMy5_Lox4',
        url: 'https://youtu.be/m8dMy5_Lox4',
        thumb: 'https://i.ytimg.com/vi/m8dMy5_Lox4/mqdefault.jpg',
      },
    ]);
  });
  test('markdown images are pulled out of the text', () => {
    const r = mediaFromText(`look ![pic](https://ordfs.network/content/${OP}) and ![](b://${T})`);
    expect(r.text).toBe('look  and');
    expect(r.media.map((m) => m.ref)).toEqual([OP, `${T}_0`]);
    expect(r.media.every((m) => m.kind === 'image' && !m.guessed)).toBe(true);
  });
  test('Twetch direct .mp4 URL, Vimeo, plain links capped', () => {
    const r = mediaFromText(
      'https://media.example.com/c/1608259113116.mp4 https://vimeo.com/123456789 https://a.com/x https://b.com/y https://c.com/z',
    );
    expect(r.media[0]).toMatchObject({
      kind: 'video',
      mime: 'video/mp4',
      src: 'https://media.example.com/c/1608259113116.mp4',
    });
    expect(r.links[0]).toMatchObject({ kind: 'vimeo', id: '123456789' });
    expect(r.links).toHaveLength(2);
    expect(r.links[1]).toMatchObject({ kind: 'link', host: 'a.com' });
  });
  test('trailing punctuation and repeats', () => {
    const r = mediaFromText('see https://youtu.be/m8dMy5_Lox4. and https://youtu.be/m8dMy5_Lox4!');
    expect(r.links).toHaveLength(1);
  });
  test('youtube watch / shorts forms', () => {
    expect(linkEmbed('https://www.youtube.com/watch?v=cUDBMK7WC8U&t=3')).toMatchObject({ id: 'cUDBMK7WC8U' });
    expect(linkEmbed('https://youtube.com/shorts/cUDBMK7WC8U')).toMatchObject({ id: 'cUDBMK7WC8U' });
    expect(linkEmbed('ftp://x')).toBeNull();
  });
  test('ignores unsafe schemes in markdown', () => {
    expect(mediaFromText('![x](javascript:alert(1))').media).toHaveLength(0);
  });
});

test('mediaFromMap and dedupe', () => {
  const m = mediaFromMap({
    app: 'bWallet',
    media_0: `${OP}|video/mp4`,
    media_1: 'bad|video/mp4',
    media_x: `${OP}|audio/mpeg`,
  });
  expect(m).toHaveLength(1);
  expect(m[0]).toMatchObject({ kind: 'video', src: `https://ordfs.network/${OP}` });
  expect(dedupeMedia([...m, ...m])).toHaveLength(1);
});

describe('parseBmapPost with media', () => {
  test('live Twetch shape: stripped B image + MAP comment', () => {
    const p = parseBmapPost({
      _id: T,
      B: [{ 'content-type': 'image/jpeg', encoding: 'binary', filename: 'twetch_twembed1568890702603.jpg' }],
      MAP: [{ app: 'twetch', type: 'post', comment: 'Twetch empowers the individual', mb_user: '2022', reply: 'null' }],
      blk: { i: 600686, t: 0 },
      timestamp: 1747066499317,
      tx: { h: T },
    })!;
    expect(p.text).toBe('Twetch empowers the individual');
    expect(p.media).toHaveLength(1);
    expect(p.images[0].src).toBe(`https://ordfs.network/${T}_0`);
  });
  test('live Twetch video with "null" comment still shows', () => {
    const p = parseBmapPost({
      _id: T,
      B: [{ 'content-type': 'video/mp4', encoding: 'binary', filename: 'twetch_twembed1593099342133.mp4' }],
      MAP: [{ app: 'twetch', type: 'post', comment: 'null' }],
      tx: { h: T },
    })!;
    expect(p.text).toBe('');
    expect(p.media[0].kind).toBe('video');
  });
  test('bWallet multi-image + poster + inscribed video round-trip', () => {
    const img = (n: number) => ({ bytes: [0xff, 0xd8, n], mime: 'image/jpeg', filename: `image${n}.jpg` });
    const script = buildPostScript({
      text: 'trip',
      media: [img(1), img(2), { bytes: [0xff, 0xd8, 9], mime: 'image/jpeg', filename: 'poster.jpg' }],
      refs: [{ outpoint: OP, mime: 'video/mp4' }],
    });
    const d = decodeScript(script)!;
    expect(d.B).toHaveLength(4);
    expect(d.MAP.media_0).toBe(`${OP}|video/mp4`);
    expect(Buffer.from(d.B[0].content).toString()).toBe(`trip\nhttps://ordfs.network/${OP}`);
    // As bmap would index it.
    const p = parseBmapPost({
      _id: T,
      B: d.B.map((b) => ({
        'content-type': b.mime,
        content: b.mime.startsWith('text')
          ? Buffer.from(b.content).toString()
          : Buffer.from(b.content).toString('base64') + 'AAAAAAAAAAAAAAAAAAAA',
        filename: b.filename,
      })),
      MAP: [d.MAP],
      tx: { h: T },
    })!;
    expect(p.media.map((m) => m.kind)).toEqual(['image', 'image', 'video']);
    expect(p.media[2].poster?.startsWith('data:image/jpeg')).toBe(true);
    expect(p.text).toBe(`trip\nhttps://ordfs.network/${OP}`);
  });
});

describe('posting limits', () => {
  test('validatePost: images, AV, refs', () => {
    const img = { bytes: [1], mime: 'image/jpeg' };
    expect(validatePost({ text: '', media: [img] })).toBeNull();
    expect(validatePost({ text: 'a', media: [img, img, img, img, img] })).toMatch(/Up to 4/);
    expect(validatePost({ text: 'a', media: [{ bytes: [1], mime: 'video/mp4' }] })).toBeNull();
    expect(
      validatePost({ text: 'a', media: [{ bytes: new Array(MAX_INLINE_AV_BYTES + 1).fill(0), mime: 'audio/mpeg' }] }),
    ).toMatch(/too large/);
    expect(validatePost({ text: 'a', media: [{ bytes: [1], mime: 'application/zip' }] })).toMatch(/cannot/);
    expect(validatePost({ text: '', refs: [{ outpoint: OP, mime: 'audio/mpeg' }] })).toBeNull();
    expect(validatePost({ text: 'a', refs: [{ outpoint: 'nope', mime: 'audio/mpeg' }] })).toMatch(/not valid/);
  });
  test('planAv', () => {
    expect(planAv(50_000, 'video/mp4')).toEqual({ mode: 'inline' });
    expect(planAv(5_000_000, 'audio/mpeg')).toEqual({ mode: 'inscribe' });
    expect(planAv(MAX_INSCRIBED_AV_BYTES + 1, 'video/mp4').mode).toBe('reject');
    expect(planAv(10, 'video/x-msvideo').mode).toBe('reject');
  });
});

describe('safety over media', () => {
  const base = {
    text: 'hi',
    images: [],
    links: [],
    app: 'treechat',
    source: 'treechat' as const,
    threadId: null,
    replyTo: null,
    author: { address: '1A', bapId: null, name: 'a', avatar: null },
    at: 1,
    likes: 0,
    replies: 0,
  };
  test('blocklisted media outpoint hides the post', () => {
    const p = { ...base, txid: T, media: mediaFromText(`https://3dordi.io/ordinal/${OP}`).media };
    const s = new SafetyFilter(normalizeBlocklist({ outpoints: [OP] }));
    expect(visiblePosts([p], [], s)).toHaveLength(0);
    expect(visiblePosts([p], [], new SafetyFilter(normalizeBlocklist({})))).toHaveLength(1);
  });
  test('reported (hidden) media txid hides the post; keyword in a media URL hides it', () => {
    const p = { ...base, txid: '0'.repeat(64), media: mediaFromText(`b://${T}`).media };
    expect(visiblePosts([p], [], new SafetyFilter(normalizeBlocklist({}), new Set([`${T}_0`])))).toHaveLength(0);
    const q = { ...base, txid: '1'.repeat(64), media: [], links: mediaFromText('https://porn.example/x').links };
    expect(visiblePosts([q], [], new SafetyFilter(normalizeBlocklist({ keywords: ['porn'] })))).toHaveLength(0);
  });
  test('mediaSafety collects ids + urls', () => {
    const r = mediaSafety(mediaFromText(`https://ordfs.network/${OP}`).media);
    expect(r.ids).toEqual([OP, OP.split('_')[0]]);
    expect(r.texts).toEqual([`https://ordfs.network/${OP}`]);
  });
});

test('Twetch API posts carry file media refs and text links', () => {
  const [p] = parseTwetchFeed({
    data: [
      {
        type: 'post',
        txid: T,
        content: 'watch https://youtu.be/m8dMy5_Lox4',
        files: JSON.stringify([`b://${OP.split('_')[0]}`]),
        userId: '7',
        postedAtMs: 5,
      },
    ],
    users: { '7': { name: 'x' } },
  });
  expect(p.media).toHaveLength(1);
  expect(p.media[0].ref).toBe(OP);
  expect(p.links[0]).toMatchObject({ kind: 'youtube' });
});
