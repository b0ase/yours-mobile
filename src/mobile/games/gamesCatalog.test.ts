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
  test('all 18 TokenBlaster arcade games are listed, each with its own cover and its own page', () => {
    expect(TOKENBLASTER_GAMES).toHaveLength(18);
    for (const g of TOKENBLASTER_GAMES)
      expect(g.img).toMatch(/^https:\/\/www\.tokenblaster\.lol\/arcade\/[\w-]+\.jpg$/);
    expect(new Set(TOKENBLASTER_GAMES.map((g) => g.img)).size).toBe(18);
    expect(new Set(TOKENBLASTER_GAMES.map((g) => g.url)).size).toBe(18);
  });
  test('store build: only our own games marked storeSafe, and none is marked today', () => {
    const all: Game[] = [...GAMES, ...TOKENBLASTER_GAMES];
    expect(all.length).toBeGreaterThan(20);
    expect(gamesFor(all, true)).toEqual([]);
    expect(gamesFor(all, false)).toHaveLength(all.length);
    // The rule itself: ours + storeSafe + not real money. Third-party titles never pass, whatever they are marked.
    const g = (over: Partial<Game>): Game => ({
      name: 'x',
      url: 'https://x.example',
      desc: 'x',
      source: 'b0ase',
      ...over,
    });
    const rows = [
      g({ name: 'ours, checked', storeSafe: true }),
      g({ name: 'ours, unchecked' }),
      g({ name: 'ours, real money', storeSafe: true, realMoney: true }),
      g({ name: 'theirs', source: 'third-party', storeSafe: true }),
      g({ name: 'arcade', source: 'tokenblaster', storeSafe: true }),
    ];
    expect(gamesFor(rows, true).map((x) => x.name)).toEqual(['ours, checked']);
    expect(gamesFor(rows, false)).toHaveLength(5);
  });
});
