import { describe, expect, test } from 'bun:test';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
(globalThis as Record<string, unknown>).__MARKET_BLOCKLIST_URL__ = '';
(globalThis as Record<string, unknown>).__MARKET_REPORT_URL__ = '';
const c = await import('./collections');
const { isSafeImageType } = await import('./bpics');

const FOX = '1611d956f397caa80b56bc148b4bce87b54f39b234aeca4668b4d5a7785eb9fa_0';
const OTHER = 'a'.repeat(64) + '_0';
const tx = (n: number) => n.toString(16).padStart(64, '0');
const row = (n: number, o: { coll?: string; type?: string; price?: number; sub?: unknown; name?: string } = {}) => ({
  outpoint: `${tx(n)}_1`,
  owner: `1Owner${n}`,
  height: 900_000 + n,
  origin: {
    outpoint: `${tx(n)}_${n}`,
    data: {
      map: {
        name: o.name ?? `Pixel Foxes #${n}`,
        subTypeData: o.sub ?? { collectionId: o.coll ?? FOX, mintNumber: String(n) },
      },
      insc: { file: { type: o.type ?? 'image/png' } },
    },
  },
  data: { list: o.price === undefined ? undefined : { price: o.price } },
});

describe('allowlist gate', () => {
  test('Foxes Pixel is on the live allowlist', () => {
    expect(c.allowedCollection(FOX)?.name).toBe('Pixel Foxes');
    expect(c.allowedCollection(FOX.replace('_', '.'))).not.toBeNull();
    expect(c.allowedCollection(FOX.toUpperCase())).not.toBeNull();
  });
  test('anything else is refused', () => {
    expect(c.allowedCollection(OTHER)).toBeNull();
    expect(c.allowedCollection('')).toBeNull();
    expect(c.allowedCollection(undefined)).toBeNull();
    expect(c.allowedCollection('testCat')).toBeNull();
    expect(c.allowedCollection(FOX.slice(0, 20))).toBeNull();
  });
});

describe('content-type gate', () => {
  test('raster images only', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif'])
      expect(isSafeImageType(t)).toBe(true);
    for (const t of ['image/svg+xml', 'text/html', 'application/json', 'video/mp4', '', undefined])
      expect(isSafeImageType(t)).toBe(false);
  });
});

describe('parseCollection', () => {
  test('keeps allowlisted raster items with number, owner and price', () => {
    const out = c.parseCollection([row(5, { price: 21000 })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      origin: `${tx(5)}_5`,
      number: '5',
      owner: '1Owner5',
      price: 21000,
      collectionId: FOX,
    });
  });
  test('drops other collections, unsafe types, bad origins and duplicates', () => {
    const bad = { ...row(3), origin: { ...row(3).origin, outpoint: 'nope' }, outpoint: 'nope' };
    const out = c.parseCollection([
      row(1, { coll: OTHER }),
      row(2, { type: 'image/svg+xml' }),
      row(4, { type: 'text/html' }),
      bad,
      row(6),
      row(6),
    ]);
    expect(out.map((p) => p.number)).toEqual(['6']);
  });
  test('reads subTypeData given as a JSON string; mintNumber when the name has no #', () => {
    const out = c.parseCollection([
      row(7, { name: 'A fox', sub: JSON.stringify({ collectionId: FOX, mintNumber: '42' }) }),
    ]);
    expect(out[0]?.number).toBe('42');
    expect(out[0]?.price).toBe(0);
  });
  test('non-arrays give nothing', () => {
    expect(c.parseCollection({ message: 'Not Found' })).toEqual([]);
    expect(c.parseCollection(null)).toEqual([]);
  });
  test('a custom allowlist is respected', () => {
    expect(
      c.parseCollection([row(1, { coll: OTHER })], [{ id: OTHER, name: 'X', artist: 'Y', description: '' }]),
    ).toHaveLength(1);
    expect(c.parseCollection([row(1)], [])).toEqual([]);
  });
});

describe('collectionUrl + fetch', () => {
  test('market search by collectionId', () => {
    const u = new URL(c.collectionUrl(FOX, 30));
    expect(u.pathname).toBe('/api/market');
    expect(u.searchParams.get('offset')).toBe('30');
    expect(JSON.parse(atob(u.searchParams.get('q') ?? ''))).toEqual({ map: { subTypeData: { collectionId: FOX } } });
  });
  test('caches briefly, never fetches a non-allowlisted collection', async () => {
    c.clearCollectionCache();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify([row(1), row(2, { coll: OTHER })]));
    }) as unknown as typeof fetch;
    let t = 1_000;
    const a = await c.fetchCollectionPage(FOX, 0, f, () => t);
    expect(a.pics).toHaveLength(1);
    expect(a.rawCount).toBe(2);
    await c.fetchCollectionPage(FOX, 0, f, () => t);
    expect(calls).toBe(1);
    t += c.CACHE_MS + 1;
    await c.fetchCollectionPage(FOX, 0, f, () => t);
    expect(calls).toBe(2);
    expect((await c.fetchCollectionPage(OTHER, 0, f)).pics).toEqual([]);
    expect(calls).toBe(2);
  });
  test('HTTP errors throw', async () => {
    c.clearCollectionCache();
    const f = (async () => new Response('x', { status: 504 })) as unknown as typeof fetch;
    await expect(c.fetchCollectionPage(FOX, 0, f)).rejects.toThrow('504');
  });
});
