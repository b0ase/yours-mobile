import { describe, expect, test } from 'bun:test';
import * as n from './npgAvatar';
import { FIXTURE_COLLECTION, FIXTURE_ROWS, fixtureListings, fixtureRow } from './npgFixtures';

const mapOf = (i = 0) => ({ ...FIXTURE_ROWS[i].origin.data.map });
const origin = FIXTURE_ROWS[0].origin.outpoint;

describe('config', () => {
  test('off until the parent origin is set', () => {
    expect(n.NPG_AVATARS_COLLECTION).toBe('');
    expect(n.npgAvatarsEnabled('')).toBe(false);
    expect(n.npgAvatarsEnabled(FIXTURE_COLLECTION)).toBe(true);
  });
});

describe('parseNpgAvatar', () => {
  test('reads the MAP spec', () => {
    const a = n.parseNpgAvatar(origin, mapOf(), FIXTURE_COLLECTION)!;
    expect(a.card).toBe(112);
    expect(a.name).toBe('NPG Avatar #0112');
    expect(a.url).toBe('https://www.ninjapunkgirls.com/s2/112');
    expect(a.score).toBe(n.sumStats(a.stats));
    expect(a.mintNumber).toBe(1);
    expect(a.stream).toBe('drop');
    expect(n.npgImageUrl(a)).toEndWith('/s2/v2/0112.webp');
  });
  test('rejects other apps, kinds, collections and broken stats', () => {
    expect(n.parseNpgAvatar(origin, { ...mapOf(), app: 'x' }, FIXTURE_COLLECTION)).toBeNull();
    expect(n.parseNpgAvatar(origin, { ...mapOf(), 'npg.kind': 'card' }, FIXTURE_COLLECTION)).toBeNull();
    expect(n.parseNpgAvatar(origin, mapOf(), 'a'.repeat(64) + '_0')).toBeNull();
    expect(n.parseNpgAvatar(origin, { ...mapOf(), 'npg.stats': '{"strength":1}' }, FIXTURE_COLLECTION)).toBeNull();
    expect(n.parseNpgAvatar('nope', mapOf(), FIXTURE_COLLECTION)).toBeNull();
  });
  test('score is the sum of the stats, not the claimed npg.score', () => {
    const a = n.parseNpgAvatar(origin, { ...mapOf(), 'npg.score': '99999' }, FIXTURE_COLLECTION)!;
    expect(a.score).toBe(n.sumStats(a.stats));
  });
  test('a foreign npg.url is replaced by the card page', () => {
    const a = n.parseNpgAvatar(origin, { ...mapOf(), 'npg.url': 'https://evil.example/x' }, FIXTURE_COLLECTION)!;
    expect(a.url).toBe('https://www.ninjapunkgirls.com/s2/112');
  });
  test('a stack origin as the card uses the inscription itself as the picture', () => {
    const stack = 'b'.repeat(64) + '_1';
    const a = n.parseNpgAvatar(origin, { ...mapOf(), 'npg.card': stack, 'npg.url': '' }, FIXTURE_COLLECTION)!;
    expect(a.card).toBeNull();
    expect(n.npgImageUrl(a)).toBe(`https://ordfs.network/content/${a.origin}`);
    expect(n.npgQrTarget(a)).toBe(`https://1satordinals.com/outpoint/${a.origin}`);
  });
  test('Style is how sexiness is shown', () => {
    expect(n.statLabel('sexiness')).toBe('Style');
    expect(n.statLabel('speed')).toBe('Speed');
  });
});

describe('market', () => {
  test('listings parse, dedupe and need a price', () => {
    const rows = [...FIXTURE_ROWS, FIXTURE_ROWS[0], { ...fixtureRow(9, 99), data: { list: { price: 0 } } }];
    expect(n.parseNpgListings(rows, FIXTURE_COLLECTION)).toHaveLength(FIXTURE_ROWS.length);
    expect(n.parseNpgListings(null)).toEqual([]);
  });
  test('filter by score, stat, price and number', () => {
    const all = fixtureListings();
    const top = Math.max(...all.map((l) => l.score));
    expect(n.filterNpg(all, { ...n.NPG_EMPTY_FILTER, minScore: top })).toHaveLength(1);
    expect(n.filterNpg(all, { ...n.NPG_EMPTY_FILTER, query: '#0112' })[0].card).toBe(112);
    expect(n.filterNpg(all, { ...n.NPG_EMPTY_FILTER, maxPriceSats: 0 })).toEqual([]);
    const fast = n.filterNpg(all, { ...n.NPG_EMPTY_FILTER, minStat: { speed: 80 } });
    expect(fast.every((l) => l.stats.speed >= 80)).toBe(true);
  });
  test('sorts', () => {
    const all = fixtureListings();
    const s = n.sortNpg(all, 'score-desc');
    expect(s[0].score).toBe(Math.max(...all.map((l) => l.score)));
    const p = n.sortNpg(all, 'price-asc');
    expect(p[0].priceSats).toBe(Math.min(...all.map((l) => l.priceSats)));
    const st = n.sortNpg(all, 'stat-sexiness');
    expect(st[0].stats.sexiness).toBe(Math.max(...all.map((l) => l.stats.sexiness)));
    expect(n.sortNpg(all, 'number')[0].card).toBe(7);
  });
  test('market url filters by collection', () => {
    const u = new URL(n.npgMarketUrl(FIXTURE_COLLECTION));
    expect(u.pathname).toBe('/api/market');
    expect(JSON.parse(atob(u.searchParams.get('q')!))).toEqual({
      map: { subTypeData: { collectionId: FIXTURE_COLLECTION } },
    });
  });
  test('actions', () => {
    expect(n.npgActions({ stream: 'claim' }, { owned: true })).toEqual(['list']);
    expect(n.npgActions({ stream: 'claim' }, { owned: false, listedPrice: 10 })).toEqual(['buy', 'claim']);
    expect(n.npgActions({ stream: 'drop' }, { owned: false })).toEqual([]);
  });
});

describe('qr', () => {
  test('only https links become a QR', async () => {
    const { qrDataUri } = await import('./npgQr');
    expect(qrDataUri('https://www.ninjapunkgirls.com/s2/112')).toStartWith('data:image/svg+xml');
    expect(qrDataUri('L1secretwif')).toBe('');
  });
});
