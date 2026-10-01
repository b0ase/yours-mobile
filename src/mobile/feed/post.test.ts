import { describe, expect, test } from 'bun:test';
import { Script, Utils } from '@bsv/sdk';
import { SafetyFilter, normalizeBlocklist } from '../market/safety';
import {
  AIP_PREFIX,
  avatarSeed,
  B_PREFIX,
  MAP_PREFIX,
  MAX_INLINE_IMAGE_BYTES,
  buildBranchScript,
  buildFollowScript,
  buildQuoteScript,
  buildLikeScript,
  buildPostScript,
  decodeScript,
  estimatePostFee,
  mediaUrl,
  parseBmapFeed,
  parseBmapPost,
  parseIdentity,
  parseLikes,
  validatePost,
} from './post';
import { visiblePosts } from './store';

const TXID = 'b6006fca35b647f5a186f60987811871fbfda6eeffeee52be4fde287d8852cae';
const utf8 = (d: number[]) => Utils.toUTF8(d);

describe('buildPostScript', () => {
  test('text post: B + MAP, round-trips', () => {
    const s = buildPostScript({ text: '  gm from bWallet  ' });
    expect(s.chunks[0].op).toBe(0);
    const d = decodeScript(Script.fromHex(s.toHex()))!;
    expect(d.B).toHaveLength(1);
    expect(utf8(d.B[0].content)).toBe('gm from bWallet');
    expect(d.B[0].mime).toBe('text/markdown');
    expect(d.B[0].encoding).toBe('UTF-8');
    expect(d.MAP).toEqual({ app: 'bChat', type: 'post' });
    expect(d.aip).toBeNull();
  });

  test('reply carries context tx', () => {
    const d = decodeScript(buildPostScript({ text: 'agreed', replyTo: TXID.toUpperCase() }))!;
    expect(d.MAP).toEqual({ app: 'bChat', type: 'post', context: 'tx', tx: TXID });
  });

  test('image post: second B with binary bytes', () => {
    const bytes = [0xff, 0xd8, 0xff, 0x7c, 0x00, 0x01];
    const d = decodeScript(buildPostScript({ text: 'pic', image: { bytes, mime: 'image/jpeg', filename: 'a.jpg' } }))!;
    expect(d.B).toHaveLength(2);
    expect(d.B[1]).toEqual({ content: bytes, mime: 'image/jpeg', encoding: 'binary', filename: 'a.jpg' });
  });

  test('image only: no empty text B', () => {
    const d = decodeScript(buildPostScript({ text: ' ', image: { bytes: [1, 2, 3], mime: 'image/png' } }))!;
    expect(d.B).toHaveLength(1);
    expect(d.B[0].mime).toBe('image/png');
  });

  test('decodes an AIP section', () => {
    const s = buildPostScript({ text: 'x' });
    s.writeBin([0x7c]).writeBin(Utils.toArray(AIP_PREFIX, 'utf8')).writeBin(Utils.toArray('BITCOIN_ECDSA', 'utf8'));
    s.writeBin(Utils.toArray('1abc', 'utf8')).writeBin([9, 9]);
    expect(decodeScript(s)!.aip).toEqual({ address: '1abc', signature: [9, 9] });
  });

  test('validation', () => {
    expect(validatePost({ text: '' })).toMatch(/Write something/);
    expect(validatePost({ text: 'a'.repeat(2001) })).toMatch(/under/);
    expect(validatePost({ text: 'a', replyTo: 'nope' })).toMatch(/not valid/);
    expect(validatePost({ text: 'a', image: { bytes: [1], mime: 'image/svg+xml' } })).toMatch(/JPEG/);
    expect(
      validatePost({ text: 'a', image: { bytes: new Array(MAX_INLINE_IMAGE_BYTES + 1).fill(0), mime: 'image/jpeg' } }),
    ).toMatch(/too large/);
    expect(() => buildPostScript({ text: '' })).toThrow();
  });
});

describe('like / follow', () => {
  test('like is MAP-only with tx', () => {
    const d = decodeScript(buildLikeScript(TXID))!;
    expect(d.B).toHaveLength(0);
    expect(d.MAP).toEqual({ app: 'bChat', type: 'like', tx: TXID });
    expect(utf8(buildLikeScript(TXID).chunks[2].data!)).toBe(MAP_PREFIX);
  });
  test('unlike', () => expect(decodeScript(buildLikeScript(TXID, 'bChat', true))!.MAP.type).toBe('unlike'));
  test('follow carries bapID', () => {
    expect(decodeScript(buildFollowScript('4Z3EfnKUpmFZdBbYix33S8RmsdGS'))!.MAP).toEqual({
      app: 'bChat',
      type: 'follow',
      bapID: '4Z3EfnKUpmFZdBbYix33S8RmsdGS',
    });
    expect(() => buildFollowScript('bad id!')).toThrow();
    expect(() => buildLikeScript('abc')).toThrow();
  });
});

test('fee estimate grows with size', () => {
  expect(estimatePostFee(100, 100)).toBe(Math.ceil((550 * 100) / 1000));
  expect(estimatePostFee(10_000, 100)).toBeGreaterThan(estimatePostFee(100, 100));
  expect(estimatePostFee(0, 0)).toBeGreaterThanOrEqual(1);
});

// A trimmed real response from bmap-api /social/feed.
const feed = {
  results: [
    {
      _id: TXID,
      AIP: [{ algorithm: 'BITCOIN_ECDSA', address: '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK' }],
      B: [{ encoding: 'UTF-8', content: 'Oh Honey', 'content-type': 'text/markdown' }],
      MAP: [{ CMD: 'SET', app: 'treechat', type: 'post', username: 'HOU', bapID: '' }],
      blk: { i: 944922, t: 0 },
      timestamp: 1789800256795,
      tx: { h: TXID },
    },
    {
      tx: { h: 'a'.repeat(64) },
      AIP: [{ address: '1PirUHzNUJAhAjdrq5M3orHYJu4Z4LeBX9' }],
      B: [
        { content: 'reply', 'content-type': 'text/plain' },
        { content: 'iVBORw0KGgoAAAANSUhEUgAA', 'content-type': 'image/png', encoding: 'binary' },
      ],
      MAP: [{ app: 'bsocial', type: 'post', context: 'tx', tx: TXID }],
      timestamp: 1789800256000,
    },
    { tx: { h: 'c'.repeat(64) }, MAP: [{ app: 'x', type: 'like', tx: TXID }], B: [] },
    { tx: { h: TXID }, B: [{ content: 'dupe', 'content-type': 'text/plain' }], MAP: [{ type: 'post' }] },
  ],
  signers: [
    {
      idKey: '4Z3EfnKUpmFZdBbYix33S8RmsdGS',
      currentAddress: '1PirUHzNUJAhAjdrq5M3orHYJu4Z4LeBX9',
      identity: '{"@type":"Person","alternateName":"MemoTest2","image":"b://' + 'd'.repeat(64) + '"}',
    },
  ],
  meta: [{ tx: TXID, likes: 14, replies: 1 }],
};

describe('parseBmapFeed', () => {
  const posts = parseBmapFeed(feed);
  test('keeps posts, drops likes and dupes, newest first', () => {
    expect(posts.map((p) => p.txid)).toEqual([TXID, 'a'.repeat(64)]);
  });
  test('author from MAP username, counts from meta', () => {
    expect(posts[0]).toMatchObject({ text: 'Oh Honey', app: 'treechat', likes: 14, replies: 1, replyTo: null });
    expect(posts[0].author).toMatchObject({ name: 'HOU', address: '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK', bapId: null });
  });
  test('signer identity, reply context, inline image', () => {
    const p = posts[1];
    expect(p.replyTo).toBe(TXID);
    expect(p.author).toMatchObject({ name: 'MemoTest2', bapId: '4Z3EfnKUpmFZdBbYix33S8RmsdGS' });
    expect(p.author.avatar).toBe(`https://ordfs.network/${'d'.repeat(64)}_0`);
    expect(p.images[0].src).toBe('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA');
  });
  test('junk in, nothing out', () => {
    expect(parseBmapFeed(null)).toEqual([]);
    expect(parseBmapPost({ tx: { h: 'zz' } })).toBeNull();
  });
});

test('mediaUrl only allows https / on-chain refs', () => {
  expect(mediaUrl('javascript:alert(1)')).toBeNull();
  expect(mediaUrl('http://x.com/a.png')).toBeNull();
  expect(mediaUrl('https://x.com/a.png')).toBe('https://x.com/a.png');
  expect(mediaUrl(`bitfs://${'e'.repeat(64)}.out.0.3`)).toBe(`https://ordfs.network/${'e'.repeat(64)}_0`);
});

test('parseIdentity', () => {
  expect(parseIdentity('{"givenName":"Memo","familyName":"Test"}').name).toBe('Memo Test');
  expect(parseIdentity('not json')).toEqual({ name: '', avatar: null });
});

test('parseLikes', () => {
  const body = { count: 2, results: [{ AIP: [{ address: '1me' }] }, { AIP: [{ address: '1you' }] }] };
  expect(parseLikes(body, ['1me'])).toEqual({ count: 2, mine: true });
  expect(parseLikes(body, ['1x']).mine).toBe(false);
});

test('visiblePosts applies the safety filter and mutes', () => {
  const posts = parseBmapFeed(feed);
  const s = new SafetyFilter(normalizeBlocklist({ keywords: ['honey'] }));
  expect(visiblePosts(posts, [], s).map((p) => p.txid)).toEqual(['a'.repeat(64)]);
  const none = new SafetyFilter(normalizeBlocklist({}));
  expect(visiblePosts(posts, ['4Z3EfnKUpmFZdBbYix33S8RmsdGS'], none).map((p) => p.txid)).toEqual([TXID]);
  expect(visiblePosts(posts, [], new SafetyFilter(normalizeBlocklist({}), new Set([TXID]))).length).toBe(1);
});

test('B prefix constant is the bitcom B address', () => expect(B_PREFIX).toBe('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'));

describe('branch and quote', () => {
  const TXID = 'cd'.repeat(32);
  test("branch is a Bitcoin Schema repost, app bWallet, sharing Twetch's tx key", () => {
    const d = decodeScript(buildBranchScript(TXID.toUpperCase()))!;
    expect(d.B).toEqual([]);
    expect(d.MAP).toEqual({ app: 'bChat', type: 'repost', context: 'tx', tx: TXID });
    expect(() => buildBranchScript('nope')).toThrow();
  });
  test('quote is a post naming the original, with its link, never a reply', () => {
    const link = `https://twetch.com/t/${TXID}`;
    const d = decodeScript(buildQuoteScript('  so true ', TXID, link))!;
    expect(Utils.toUTF8(d.B[0].content)).toBe(`so true\n${link}`);
    expect(d.MAP).toEqual({ app: 'bChat', type: 'post', quote: TXID });
    expect(d.MAP.app).not.toBe('twetch');
    const parsed = parseBmapPost({
      tx: { h: 'ef'.repeat(32) },
      MAP: [d.MAP],
      B: [{ content: 'so true', 'content-type': 'text/markdown' }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.replyTo).toBeNull();
    expect(() => buildQuoteScript('x', 'bad', null)).toThrow();
  });
});

describe('avatarSeed', () => {
  const relay = '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK';
  test('gives Treechat authors sharing the relay address distinct seeds by username', () => {
    const a = avatarSeed({ address: relay, name: 'RosaAmargada', bapId: null }, 'treechat');
    const b = avatarSeed({ address: relay, name: 'MissBigPig', bapId: null }, 'treechat');
    expect(a).not.toBe(b);
  });
  test('keeps address seeding elsewhere', () => {
    expect(avatarSeed({ address: relay, name: 'x', bapId: null }, 'bchat')).toBe(relay);
  });
});
