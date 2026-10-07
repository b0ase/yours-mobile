import { describe, expect, test } from 'vitest';
import { GAMES, gamesFor, type Game } from './gamesCatalog';
import { TOKENBLASTER_GAMES } from './gamesCatalogX';

describe('games catalogue', () => {
  test('every game has a name, https url, one-line desc and a known source', () => {
    for (const g of GAMES) {
      expect(g.name).toBeTruthy();
      expect(g.url).toMatch(/^https:\/\//);
      expect(g.desc.length).toBeLessThan(80);
      expect(['b0ase', 'tokenblaster', 'third-party']).toContain(g.source);
    }
    expect(new Set(GAMES.map((g) => g.name)).size).toBe(GAMES.length);
  });
  test('all 17 TokenBlaster arcade games are listed', () => {
    expect(TOKENBLASTER_GAMES).toHaveLength(17);
  });
  test('store build: no real-money or TokenBlaster games', () => {
    const all: Game[] = [...GAMES, ...TOKENBLASTER_GAMES];
    const store = gamesFor(all, true);
    expect(store.some((g) => g.realMoney || g.source === 'tokenblaster')).toBe(false);
    expect(store.length).toBeGreaterThan(0);
    expect(gamesFor(all, false)).toHaveLength(all.length);
  });
});
