import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import lib from '../lib/library.js';
import pm from '../lib/paymail.js';
import api from '../api/library.js';

const NOW = 1_800_000_000_000;
const HEX = {
  bg: '#000000',
  surface: '#111111',
  accent: '#ffcc00',
  accent2: '#ff00ff',
  text: '#ffffff',
  muted: '#888888',
};
const MANIFEST = {
  albums: [
    {
      id: 'album-one',
      title: 'Album One',
      cover: 'covers/album-one.jpg',
      theme: HEX,
      tracks: [
        { id: '01', title: 'First', path: 'audio/album-one/01.mp3', duration: 120 },
        { id: '02', title: 'Second', path: 'audio/album-one/02.mp3' },
      ],
    },
  ],
};

const user = (n) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (ts = NOW, action = lib.ACTION) => {
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, { identityKey, timestamp: String(ts) }), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: ts, fields: {}, signature: Utils.toHex(signature) };
  };
  return { identityKey, sign };
};

const owner = user(7);
const other = user(8);

const setup = (over = {}) => {
  const calls = { signed: [] };
  const storage = {
    readManifest: async () => over.manifest ?? MANIFEST,
    signMany: async (paths, expiresIn) => {
      calls.signed.push({ paths, expiresIn });
      return Object.fromEntries(
        paths.map((p) => [p, `https://db.example/storage/v1/object/sign/owner-library/${p}?token=t`]),
      );
    },
  };
  const aliases = {
    getAlias: async (a) => (a === 'b0asex' ? { alias: a, identity_key: over.boundKey ?? owner.identityKey } : null),
  };
  const session = lib.makeLibraryHandler({ aliases, storage, now: () => NOW, ...over.deps });
  return { session, calls };
};

describe('library session', () => {
  test('owner gets albums with signed URLs, TTL <= 3600 s', async () => {
    const { session, calls } = setup();
    const [status, body] = await session(await owner.sign(), '1.1.1.1');
    expect(status).toBe(200);
    expect(calls.signed[0].expiresIn).toBeLessThanOrEqual(3600);
    expect(body.expiresAt).toBeLessThanOrEqual(NOW + 3600 * 1000);
    expect(body.albums[0].cover).toStartWith('https://');
    expect(body.albums[0].tracks[0]).toEqual({
      id: '01',
      title: 'First',
      duration: 120,
      url: expect.stringContaining('01.mp3'),
    });
    expect(body.albums[0].tracks[1].path).toBeUndefined();
    expect(body.albums[0].theme.accent).toBe('#FFCC00');
  });

  test('ttl option can only shorten', async () => {
    const { session, calls } = setup({ deps: { ttl: 99999 } });
    await session(await owner.sign(), 'ip');
    expect(calls.signed[0].expiresIn).toBe(3600);
  });

  test('another key is 403', async () => {
    const { session } = setup();
    expect((await session(await other.sign(), 'ip'))[0]).toBe(403);
  });

  test('alias moved to another key is 403 for the old key', async () => {
    const { session } = setup({ boundKey: other.identityKey });
    expect((await session(await owner.sign(), 'ip'))[0]).toBe(403);
  });

  test('timestamps more than 120 s off are refused', async () => {
    const { session } = setup();
    expect((await session(await owner.sign(NOW - 121_000), 'ip'))[0]).toBe(401);
    expect((await session(await owner.sign(NOW + 121_000), 'ip'))[0]).toBe(401);
    expect((await session(await owner.sign(NOW - 119_000), 'ip'))[0]).toBe(200);
  });

  test('bad signature, wrong action, non-empty fields', async () => {
    const { session } = setup();
    const s = await owner.sign();
    expect((await session({ ...s, signature: s.signature.replace(/^../, '00') }, 'ip'))[0]).toBe(401);
    expect((await session(await owner.sign(NOW, 'bind'), 'ip'))[0]).toBe(401);
    expect((await session({ ...s, fields: { x: '1' } }, 'ip'))[0]).toBe(400);
    expect((await session({ ...s, identityKey: 'nope' }, 'ip'))[0]).toBe(401);
  });

  test('replayed signature is refused', async () => {
    const { session } = setup();
    const s = await owner.sign();
    expect((await session(s, 'ip'))[0]).toBe(200);
    expect((await session(s, 'ip'))[0]).toBe(401);
  });

  test('rate limits per IP and per key', async () => {
    const { session } = setup({ deps: { ipLimit: lib.limiter(1), keyLimit: lib.limiter(1) } });
    expect((await session(await owner.sign(NOW - 1), 'a'))[0]).toBe(200);
    expect((await session(await owner.sign(NOW - 2), 'b'))[0]).toBe(429); // same key
    expect((await session(await other.sign(), 'a'))[0]).toBe(429); // same IP (2nd hit)
  });

  test('not configured is 503, bad manifest is 503', async () => {
    const s = lib.makeLibraryHandler({ aliases: null, storage: null, now: () => NOW });
    expect((await s(await owner.sign(), 'ip'))[0]).toBe(503);
    const { session } = setup({ manifest: { albums: [{ ...MANIFEST.albums[0], cover: '../secret' }] } });
    expect((await session(await owner.sign(), 'ip'))[0]).toBe(503);
  });

  test('parseManifest rejects odd paths and colours', () => {
    expect(lib.parseManifest(MANIFEST)).toHaveLength(1);
    const a = MANIFEST.albums[0];
    expect(lib.parseManifest({ albums: [{ ...a, theme: { ...HEX, bg: 'red' } }] })).toBeNull();
    expect(
      lib.parseManifest({ albums: [{ ...a, tracks: [{ id: '01', title: 'x', path: 'audio/../../etc' }] }] }),
    ).toBeNull();
    expect(lib.parseManifest({ albums: [{ ...a, title: '<script>' }] })).toBeNull();
  });
});

describe('library route', () => {
  const res = () => {
    const h = {};
    return {
      h,
      statusCode: 0,
      setHeader: (k, v) => (h[k.toLowerCase()] = v),
      end(b) {
        this.body = b;
      },
    };
  };

  test('CORS only for wallet origins; no-store always', async () => {
    const r1 = res();
    await api(
      { method: 'OPTIONS', url: '/api/library?op=session', headers: { origin: 'https://web.bwalletx.com' } },
      r1,
    );
    expect(r1.h['access-control-allow-origin']).toBe('https://web.bwalletx.com');
    expect(r1.h['cache-control']).toContain('no-store');
    const r2 = res();
    await api({ method: 'OPTIONS', url: '/api/library?op=session', headers: { origin: 'https://evil.example' } }, r2);
    expect(r2.h['access-control-allow-origin']).toBeUndefined();
    expect(api.allowedOrigins({}).has('capacitor://localhost')).toBe(true);
    expect(
      api
        .allowedOrigins({ LIBRARY_EXTRA_ORIGINS: 'chrome-extension://abc, javascript:alert(1)' })
        .has('chrome-extension://abc'),
    ).toBe(true);
    expect(api.allowedOrigins({ LIBRARY_EXTRA_ORIGINS: 'javascript:alert(1)' }).size).toBe(api.WALLET_ORIGINS.length);
  });

  test('unknown op 404, GET 405', async () => {
    const r1 = res();
    await api({ method: 'POST', url: '/api/library?op=x', headers: {}, body: {} }, r1);
    expect(r1.statusCode).toBe(404);
    const r2 = res();
    await api({ method: 'GET', url: '/api/library?op=session', headers: {} }, r2);
    expect(r2.statusCode).toBe(405);
  });
});
