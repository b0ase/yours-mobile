/**
 * TEST FIXTURES for NPG Avatars: FAKE origins (never on chain). Used by tests and the dev-only ?npgav=fixtures
 * preview for screenshots. Card numbers and their circles are real S2 cards.
 */
import { pad4, parseNpgListings, STAT_KEYS, type NpgListing } from './npgAvatar';

export const FIXTURE_COLLECTION = 'f'.repeat(63) + '0_0';
const fakeTxid = (n: number) => ('abc' + String(n).padStart(4, '0')).padEnd(64, 'e');

const CARDS = [112, 7, 2045, 3333, 501, 1777, 64, 2900, 1234, 888, 42, 3010];

/** A GorillaPool-shaped market row for card n. */
export const fixtureRow = (n: number, i: number, collection = FIXTURE_COLLECTION) => {
  const stats = Object.fromEntries(STAT_KEYS.map((k, j) => [k, ((n * (j + 3) + i * 7) % 90) + 10]));
  const score = Object.values(stats).reduce((a, b) => a + b, 0);
  return {
    outpoint: `${fakeTxid(n)}_0`,
    owner: '1FakeSe11erAddressxxxxxxxxxxxxxxx',
    data: { list: { price: 50_000 + ((n * 7919) % 40) * 25_000 } },
    origin: {
      outpoint: `${fakeTxid(n)}_0`,
      data: {
        insc: { file: { type: 'image/webp' } },
        map: {
          app: 'npg',
          type: 'ord',
          subType: 'collectionItem',
          subTypeData: JSON.stringify({ collectionId: collection, mintNumber: i + 1, traits: ['Team: Fixture'] }),
          name: `NPG Avatar #${pad4(n)}`,
          'npg.kind': 'avatar',
          'npg.card': String(n),
          'npg.series': '2',
          'npg.score': String(score),
          'npg.stats': JSON.stringify(stats),
          'npg.url': `https://www.ninjapunkgirls.com/s2/${n}`,
          'npg.stream': i % 3 === 0 ? 'drop' : 'claim',
        },
      },
    },
  };
};

export const FIXTURE_ROWS = CARDS.map((n, i) => fixtureRow(n, i));
export const fixtureListings = (): NpgListing[] => parseNpgListings(FIXTURE_ROWS, FIXTURE_COLLECTION);
