import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import {
  MIN_PRICE_SATS,
  buildPhotoMap,
  claimMessage,
  cleanTags,
  forSale,
  parseItems,
  priceToSats,
  purchaseRequests,
  rankedFeed,
  validatePhoto,
  type MarketItem,
} from './listing';
import { ART_COLLECTIONS, artMarketUrl, isAllowedCollection, parseArt } from './collections';
import { RELEASE_PROTOCOL, ESCROW_PROTOCOL, deriveContentKey, openPhoto, openRelease, sealPhoto } from './crypto';
import { buyPhoto, claimChainPhotos, listPhoto, openOwnPhoto } from './flows';
import { previewSize, watermarkPositions } from './preview';

const KEY = (k: PrivateKey) => k.toPublicKey().toString();
const GBP = { currency: 'GBP' as const, usdPerUnit: 1.25 };

describe('bPics market: listing rules', () => {
  test('price: sats as typed, £ converted at the BSV rate (rounded up)', () => {
    expect(priceToSats({ unit: 'sats', value: '25,000' }, 50, GBP)).toBe(25_000);
    expect(priceToSats({ unit: 'sats', value: '1.5' }, 50, GBP)).toBeNull();
    // £2 = $2.50 at 1.25; $2.50 / $50 per BSV = 0.05 BSV = 5,000,000 sats
    expect(priceToSats({ unit: 'fiat', value: '£2' }, 50, GBP)).toBe(5_000_000);
    expect(priceToSats({ unit: 'fiat', value: '2' }, 0, GBP)).toBeNull();
    expect(priceToSats({ unit: 'fiat', value: 'abc' }, 50, GBP)).toBeNull();
  });
  test('tags are cleaned, deduped and capped', () => {
    expect(cleanTags('#Sea, sea dawn  LONDON!')).toEqual(['sea', 'dawn', 'london']);
    expect(cleanTags('a b c d e f g h i j')).toHaveLength(8);
  });
  test('validation', () => {
    const f = { title: 'Harbour', tags: '', licence: 'personal' as const, priceSats: 25_000 };
    expect(validatePhoto(f, 1000)).toBeNull();
    expect(validatePhoto({ ...f, title: ' ' }, 1000)).toMatch(/title/);
    expect(validatePhoto({ ...f, priceSats: MIN_PRICE_SATS - 1 }, 1000)).toMatch(/lowest/);
    expect(validatePhoto({ ...f, priceSats: null }, 1000)).toMatch(/price/);
    expect(validatePhoto(f, 13 * 1024 * 1024)).toMatch(/12 MB/);
  });
  test('MAP matches the server (bit-sign bpics.ts parsePhotoMap)', () => {
    const m = buildPhotoMap(
      { title: ' Harbour ', tags: 'sea, dawn', licence: 'commercial', priceSats: 30_000 },
      { pay: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', paymail: 'ann@bwalletx.com', idKey: '02' + 'AB'.repeat(32) },
      'CD'.repeat(16),
    );
    expect(m).toEqual({
      app: 'bwalletx',
      type: 'photo',
      name: 'Harbour',
      tags: 'sea,dawn',
      licence: 'commercial',
      price: '30000',
      pay: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      paymail: 'ann@bwalletx.com',
      idKey: '02' + 'ab'.repeat(32),
      nonce: 'cd'.repeat(16),
    });
  });
  test('a purchase pays the photographer the full price and tags item + buyer; no other outputs', () => {
    const r = purchaseRequests(
      { id: 'a'.repeat(64) + '_0', pay_address: '1Pay', price_sats: 25_000 },
      '02' + 'AB'.repeat(32),
    );
    expect(r).toEqual([
      { address: '1Pay', satoshis: 25_000 },
      { data: ['bpics', 'buy', 'a'.repeat(64) + '_0', '02' + 'ab'.repeat(32)], satoshis: 0 },
    ]);
  });
  test('claim message is the exact server text', () => {
    expect(claimMessage('1Addr', '02AB', '2026-10-15T12:00:00.000Z')).toBe(
      'bPics claim\naddress: 1Addr\nidentity: 02ab\nissued: 2026-10-15T12:00:00.000Z',
    );
  });
  test('feed: malformed rows and unsafe types dropped; public feed = approved, ranked by paid', () => {
    const row = (id: string, paid: number, status = 'approved', type = 'image/jpeg') => ({
      id: id.repeat(64) + '_0',
      source: 'mint',
      creator_key: '02' + 'ab'.repeat(32),
      pay_address: '1Pay',
      title: 'x',
      tags: ['a'],
      licence: 'personal',
      price_sats: 5000,
      preview_type: type,
      status,
      paid_sats: paid,
      created_at: '2026-10-15T00:00:00Z',
    });
    const items = parseItems({
      items: [
        row('a', 10),
        row('b', 900),
        row('c', 50, 'needs_review'),
        row('d', 1, 'approved', 'image/svg+xml'),
        { id: 'bad' },
      ],
    });
    expect(items.map((i) => i.id[0])).toEqual(['a', 'b', 'c']);
    expect(rankedFeed(items).map((i) => i.id[0])).toEqual(['b', 'a']);
    expect(forSale(items[0])).toBe(true);
  });
});

describe('bPics market: Art allowlist', () => {
  const FOX = ART_COLLECTIONS[0].id;
  test('Pixel Foxes is on the list; nothing else is', () => {
    expect(ART_COLLECTIONS.map((c) => c.name)).toEqual(['Pixel Foxes']);
    expect(isAllowedCollection(FOX)).toBe(true);
    expect(isAllowedCollection('f'.repeat(64) + '_0')).toBe(false);
    expect(() => artMarketUrl('f'.repeat(64) + '_0')).toThrow();
    expect(artMarketUrl(FOX)).toContain('/market?q=');
  });
  test('rows from another collection or non-raster types are dropped', () => {
    const r = (cid: string, type: string) => ({
      outpoint: 'a'.repeat(64) + '_3',
      origin: {
        outpoint: 'b'.repeat(64) + '_1',
        data: { map: { name: 'Fox #1', subTypeData: { collectionId: cid } }, insc: { file: { type } } },
      },
      data: { list: { price: 20000 } },
    });
    const out = parseArt(
      [r(FOX, 'image/png'), r('c'.repeat(64) + '_0', 'image/png'), r(FOX, 'image/svg+xml'), r(FOX, 'text/html')],
      FOX,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Fox #1', priceSats: 20000, contentType: 'image/png' });
    expect(parseArt([r(FOX, 'image/png')], 'c'.repeat(64) + '_0')).toEqual([]);
  });
});

describe('bPics market: crypto and flows (mock wallet, no network, nothing broadcast)', () => {
  const creator = PrivateKey.fromRandom();
  const buyer = PrivateKey.fromRandom();
  const escrow = PrivateKey.fromRandom();
  const cw = new ProtoWallet(creator);
  const bw = new ProtoWallet(buyer);
  const full = Uint8Array.from({ length: 300 }, (_, i) => i % 251);

  test('content key re-derives from the seed; seal/open round-trips; tampering fails', async () => {
    const k1 = await deriveContentKey(cw, 'ab'.repeat(16));
    const k2 = await deriveContentKey(cw, 'ab'.repeat(16));
    expect(Utils.toHex(Array.from(k1))).toBe(Utils.toHex(Array.from(k2)));
    expect(k1.length).toBe(32);
    const other = await deriveContentKey(bw, 'ab'.repeat(16));
    expect(Utils.toHex(Array.from(other))).not.toBe(Utils.toHex(Array.from(k1)));
    const sealed = await sealPhoto(k1, full);
    expect(Array.from(await openPhoto(k1, sealed))).toEqual(Array.from(full));
    sealed[20] ^= 1;
    await expect(openPhoto(k1, sealed)).rejects.toThrow();
  });

  test('list → buy end to end: one mint, escrow wrap, server re-wrap to buyer, buyer decrypts the original', async () => {
    let minted: Parameters<Parameters<typeof listPhoto>[0]['mint']>[0] | null = null;
    let registered: { itemId: string; escrow: string } | null = null;
    const txid = 'e'.repeat(64);
    const listed = await listPhoto(
      {
        wallet: cw,
        mint: async (m) => {
          minted = m;
          return { txid, outpoint: `${txid}_0`, origin: `${txid}_0`, networkSats: 50 };
        },
        client: {
          escrowKey: async () => KEY(escrow),
          register: async (itemId, e) => {
            registered = { itemId, escrow: e };
            return {};
          },
        },
      },
      {
        form: { title: 'Harbour', tags: 'sea', licence: 'personal', priceSats: 25_000 },
        previewBase64: 'AAAA',
        full,
        who: { pay: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', paymail: 'ann@bwalletx.com', idKey: KEY(creator) },
        feeSats: 0,
      },
    );
    expect(listed).toMatchObject({ itemId: `${txid}_0`, registered: true });
    const m = minted!;
    expect(m.contentType).toBe('image/jpeg');
    expect(m.map?.type).toBe('photo');
    expect(m.poster?.contentType).toBe('application/octet-stream');
    expect(m.poster?.map).toEqual({ app: 'bwalletx', type: 'photo-sealed' });
    const sealed = Uint8Array.from(Utils.toArray(m.poster!.base64Content, 'base64'));
    expect(sealed.length).toBeGreaterThan(full.length); // not the plaintext
    // The photographer re-opens their own photo from chain with only the seed + MAP nonce.
    expect(Array.from(await openOwnPhoto(cw, m.map!.nonce, sealed))).toEqual(Array.from(full));

    // bit-sign: open the escrow (counterparty = creator) and re-wrap to the buyer (bpics-service.ts unlock).
    const ew = new ProtoWallet(escrow);
    const key = (
      await ew.decrypt({
        ciphertext: Utils.toArray(registered!.escrow, 'base64'),
        protocolID: ESCROW_PROTOCOL,
        keyID: listed.itemId,
        counterparty: KEY(creator),
      })
    ).plaintext;
    const released = Utils.toBase64(
      (
        await ew.encrypt({
          plaintext: key,
          protocolID: RELEASE_PROTOCOL,
          keyID: listed.itemId,
          counterparty: KEY(buyer),
        })
      ).ciphertext,
    );

    const item: MarketItem = {
      id: listed.itemId,
      source: 'mint',
      creatorKey: KEY(creator),
      payAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      paymail: null,
      title: 'Harbour',
      tags: [],
      licence: 'personal',
      priceSats: 25_000,
      previewType: 'image/jpeg',
      status: 'approved',
      paidSats: 0,
      createdAt: 0,
    };
    const paid: unknown[] = [];
    let calls = 0;
    const got = await buyPhoto(
      {
        wallet: bw,
        identityKey: KEY(buyer),
        pay: async (r) => {
          paid.push(r);
          return 'f'.repeat(64);
        },
        client: { unlock: async () => (++calls < 2 ? null : { wrapped: released, escrowKey: KEY(escrow) }) },
        fetchSealed: async (op) => {
          expect(op).toBe(`${txid}_1`);
          return sealed;
        },
        sleep: async () => {},
      },
      item,
    );
    expect(paid).toHaveLength(1);
    expect(calls).toBe(2); // waited for the payment to be seen
    expect(Array.from(got.photo)).toEqual(Array.from(full));
    // Someone else cannot open the released key.
    await expect(
      openRelease(new ProtoWallet(PrivateKey.fromRandom()), released, item.id, KEY(escrow)),
    ).rejects.toThrow();
  });

  test('listing with sales closed: minted and kept, not registered', async () => {
    const r = await listPhoto(
      {
        wallet: cw,
        mint: async () => ({
          txid: 'a'.repeat(64),
          outpoint: 'a'.repeat(64) + '_0',
          origin: 'a'.repeat(64) + '_0',
          networkSats: 1,
        }),
        client: { escrowKey: async () => null, register: async () => ({}) },
      },
      {
        form: { title: 'x', tags: '', licence: 'personal', priceSats: 5000 },
        previewBase64: 'AA',
        full,
        who: { pay: '1Pay', paymail: '', idKey: KEY(creator) },
        feeSats: 0,
      },
    );
    expect(r.registered).toBe(false);
    expect(r.note).toMatch(/not open/);
  });

  test('an invalid form never reaches the mint', async () => {
    let mintCalled = false;
    await expect(
      listPhoto(
        {
          wallet: cw,
          mint: async () => ((mintCalled = true), {} as never),
          client: { escrowKey: async () => null, register: async () => ({}) },
        },
        {
          form: { title: '', tags: '', licence: 'personal', priceSats: 5000 },
          previewBase64: 'AA',
          full,
          who: { pay: '1', paymail: '', idKey: '' },
          feeSats: 0,
        },
      ),
    ).rejects.toThrow(/title/);
    expect(mintCalled).toBe(false);
  });

  test('claim signs the bound message with the address key', async () => {
    let signed = '';
    const r = await claimChainPhotos(
      {
        identityKey: '02AB',
        sign: async (_a, msg) => ((signed = msg), 'sig'),
        client: { claim: async (b) => ({ listed: b.origins, refused: [] }) },
        now: () => new Date('2026-10-15T12:00:00Z'),
      },
      '1Addr',
      ['a'.repeat(64) + '_0'],
    );
    expect(signed).toBe(claimMessage('1Addr', '02AB', '2026-10-15T12:00:00.000Z'));
    expect(r.listed).toHaveLength(1);
  });
});

describe('bPics market: preview geometry', () => {
  test('long side capped at 1024, aspect kept, small images untouched', () => {
    expect(previewSize(4000, 3000)).toEqual({ w: 1024, h: 768 });
    expect(previewSize(600, 800)).toEqual({ w: 600, h: 800 });
    expect(previewSize(0, 10)).toEqual({ w: 0, h: 0 });
  });
  test('watermark covers the corners', () => {
    const p = watermarkPositions(1024, 768);
    expect(p.some((q) => q.x <= 0 && q.y <= 220)).toBe(true);
    expect(p.some((q) => q.x >= 1024 && q.y >= 768)).toBe(true);
  });
});
