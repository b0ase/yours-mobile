import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import ws from '../lib/webShops.js';
import pm from '../lib/paymail.js';

const NOW = 1_800_000_000_000;

const user = (n = 42) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields = {}, extra = {}, protocolID = ws.SIGN_PROTOCOL, message = ws.signedMessage) => {
    const all = { ...fields, identityKey, timestamp: String(NOW) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(message(action, all), 'utf8'),
      protocolID,
      keyID: ws.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: NOW, fields, signature: Utils.toHex(signature), ...extra };
  };
  return { identityKey, sign };
};

const memStore = () => {
  const rows = [];
  return {
    rows,
    uploads: [],
    events: [],
    getByKey: async (k) => rows.find((r) => r.identity_key === k) ?? null,
    getByHandle: async (h) => rows.find((r) => r.handle === h) ?? null,
    insert: async (r) => (rows.push({ id: `id${rows.length}`, ...r }), rows.at(-1)),
    update: async (id, p) =>
      Object.assign(
        rows.find((r) => r.id === id),
        p,
      ),
    uploadFile: async function (path) {
      this.uploads.push(path);
    },
    signedUrl: async (p) => `https://files.example/${p}`,
    notify: async function (kind, payload) {
      this.events.push({ kind, payload });
    },
  };
};

const setup = () => {
  const store = memStore();
  return { store, h: ws.makeWebShopHandlers({ store, now: () => NOW }) };
};

const form = (o = {}) => ({
  handle: 'pixel-shop',
  name: 'Pixel Shop',
  blurb: 'Hand-made pixel art.',
  colours: JSON.stringify({ accent: '#FF2E93', background: '#000000' }),
  ...o,
});

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 1)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('web shops', () => {
  test('save a draft, then read it back with mine', async () => {
    const { h, store } = setup();
    const u = user();
    const [s, out] = await h.save(await u.sign('shop-save', form()));
    expect(s).toBe(200);
    expect(out.shop).toMatchObject({ handle: 'pixel-shop', name: 'Pixel Shop', status: 'draft' });
    expect(out.shop.colours).toEqual({ accent: '#ff2e93', background: '#000000' });
    expect(out.shop.url).toBe('https://bwalletx.com/shop/pixel-shop');
    expect(store.events.map((e) => e.kind)).toEqual(['web_shop_draft']);
    const [s2, mine] = await h.mine(await u.sign('shop-mine'));
    expect(s2).toBe(200);
    expect(mine.shop.handle).toBe('pixel-shop');
  });

  test('saving again updates the same draft (no second row, no second ops event)', async () => {
    const { h, store } = setup();
    const u = user();
    await h.save(await u.sign('shop-save', form()));
    const [s, out] = await h.save(await u.sign('shop-save', form({ name: 'Pixel Shop Two', handle: 'pixel-two' })));
    expect(s).toBe(200);
    expect(out.shop.handle).toBe('pixel-two');
    expect(store.rows.length).toBe(1);
    expect(store.events.length).toBe(1);
  });

  test("another wallet can't take a handle", async () => {
    const { h } = setup();
    await h.save(await user(1).sign('shop-save', form()));
    const [s, out] = await h.save(await user(2).sign('shop-save', form()));
    expect(s).toBe(409);
    expect(out.error).toBe('handle_taken');
    expect((await h.check({ handle: 'pixel-shop' }))[1]).toMatchObject({ available: false, reason: 'taken' });
    expect((await h.check({ handle: 'pixel-shop', identityKey: user(1).identityKey }))[1].available).toBe(true);
    expect((await h.check({ handle: 'free-one' }))[1].available).toBe(true);
  });

  test('reserved and invalid handles', async () => {
    const { h } = setup();
    const u = user();
    expect((await h.save(await u.sign('shop-save', form({ handle: 'npg' }))))[1].error).toBe('handle_reserved');
    expect((await h.save(await u.sign('shop-save', form({ handle: '-x' }))))[0]).toBe(400);
    expect((await h.check({ handle: 'bwalletx' }))[1].reason).toBe('reserved');
  });

  test('handle is fixed once the shop is past draft', async () => {
    const { h, store } = setup();
    const u = user();
    await h.save(await u.sign('shop-save', form()));
    store.rows[0].status = 'review';
    const [s, out] = await h.save(await u.sign('shop-save', form({ handle: 'other-name' })));
    expect(s).toBe(409);
    expect(out.error).toBe('handle_locked');
  });

  test('rejects tampered fields, wrong action, the paymail protocol and old timestamps', async () => {
    const { h } = setup();
    const u = user();
    const body = await u.sign('shop-save', form());
    expect((await h.save({ ...body, fields: { ...body.fields, name: 'Evil' } }))[0]).toBe(401);
    expect((await h.save(await u.sign('shop-mine', form())))[0]).toBe(401);
    const paymailSigned = await u.sign('shop-save', form(), {}, pm.SIGN_PROTOCOL, pm.signedMessage);
    expect((await h.save(paymailSigned))[0]).toBe(401);
    const stale = ws.makeWebShopHandlers({ store: memStore(), now: () => NOW + 10 * 60 * 1000 });
    expect((await stale.save(body))[0]).toBe(401);
  });

  test('upload checks hash, type and size; files must be your own', async () => {
    const { h, store } = setup();
    const u = user();
    const ok = await h.upload(
      await u.sign(
        'shop-upload',
        { kind: 'logo', type: 'image/png', sha256: sha(PNG) },
        { data: PNG.toString('base64') },
      ),
    );
    expect(ok[0]).toBe(200);
    expect(ok[1].path).toBe(`${u.identityKey}/logo-${sha(PNG)}.png`);
    expect(store.uploads).toEqual([ok[1].path]);
    const bad = await h.upload(
      await u.sign(
        'shop-upload',
        { kind: 'logo', type: 'image/jpeg', sha256: sha(PNG) },
        { data: PNG.toString('base64') },
      ),
    );
    expect(bad[1].error).toBe('file: not a valid image');
    const svg = await h.upload(
      await u.sign('shop-upload', { kind: 'logo', type: 'image/svg+xml', sha256: sha(PNG) }, { data: '' }),
    );
    expect(svg[0]).toBe(400);
    const [s, out] = await h.save(await u.sign('shop-save', form({ logo: JSON.stringify(ok[1]) })));
    expect(s).toBe(200);
    expect(out.shop.logo.url).toContain('logo-');
    const other = user(9);
    const [s2] = await h.save(await other.sign('shop-save', form({ handle: 'theirs', logo: JSON.stringify(ok[1]) })));
    expect(s2).toBe(400);
  });

  test('colours are required', async () => {
    const { h } = setup();
    const [s, out] = await h.save(await user().sign('shop-save', form({ colours: '{}' })));
    expect(s).toBe(400);
    expect(out.error).toMatch(/colours/);
  });
});
