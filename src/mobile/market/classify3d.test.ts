import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { categoryOf, listingsIn, nftFeed } from './classify';

// A real 3D listing on the 1Sat order book (7 Oct 2026): "Kowry Glider #006", a GLB from the 3D Ordi app.
const LISTING = '34727e4d0bc1895c500e30661e4de27976a757a7f10439f91f7d77eaf975447e.0';
const ORIGIN = '1f1dc8bdb7850155edfbf89137acbc058488bbef4f41b13f5414ce20d7e8a63d.0';
const IMAGE = 'aa'.repeat(32) + '.0';
const META: Record<string, unknown> = {
  [LISTING]: {
    contentType: 'model/gltf-binary',
    map: {
      app: '3D Ordi',
      name: 'Kowry Glider #006',
      subType: 'collectionItem',
      subTypeData: '{"collectionId":"3bcc981573f792e3aa4bf395392045552f1cedd7833d39625180736b18407150_0"}',
      type: 'ord',
    },
    origin: ORIGIN,
  },
  [IMAGE]: { contentType: 'image/png', map: { name: 'A picture' }, origin: IMAGE },
};
const ROWS = [LISTING, IMAGE].map((outpoint) => ({
  outpoint,
  score: 1,
  data: { ordlock: { price: 10_000_000, seller: { AddressString: '1D9saMvDKdbRkqSG7euSwjhThz7XiiwNyt' } } },
}));

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/txo/search')) return Response.json(ROWS);
    const m = url.match(/\/ordfs\/metadata\/([0-9a-f]{64}\.\d+):-2$/);
    if (m && META[m[1]]) return Response.json(META[m[1]]);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('3D listings', () => {
  test('model/* content types are 3D', () => {
    for (const t of ['model/gltf-binary', 'model/gltf+json', 'model/vnd.usdz+zip', 'MODEL/GLTF-BINARY; charset=binary'])
      expect(categoryOf(t)).toBe('3d');
    expect(categoryOf('model/')).toBeNull();
  });

  test('a real GLB listing is classified 3D and shows under the 3D filter, not Images', async () => {
    const feed = await nftFeed(7);
    const glider = feed.items.find((n) => n.outpoint === LISTING.replace('.', '_'));
    expect(glider?.category).toBe('3d');
    expect(glider?.contentType).toBe('model/gltf-binary');
    expect(glider?.origin).toBe(ORIGIN.replace('.', '_'));
    expect(feed.stats.counts['3d']).toBe(1);
    expect(feed.stats.unclassified).toBe(0);
    expect(listingsIn(feed.items, '3d').map((n) => n.name)).toEqual(['Kowry Glider #006']);
    expect(listingsIn(feed.items, 'images').map((n) => n.name)).toEqual(['A picture']);
  });
});
