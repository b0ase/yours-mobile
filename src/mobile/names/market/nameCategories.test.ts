import { describe, expect, test } from 'bun:test';
import { NAME_TIERS, classifyName, countByCategory, relistCount, sortByCategory, tierUsd } from './nameCategories';

describe('classifyName precedence', () => {
  test('brands beat everything', () => {
    expect(classifyName('tesla')).toBe('brand'); // also a first name in the SSA list
    expect(classifyName('Ford')).toBe('brand');
    expect(classifyName('kia')).toBe('brand'); // 3 letters, still a brand
  });
  test('first names beat cool words and short', () => {
    expect(classifyName('mary')).toBe('first');
    expect(classifyName('john')).toBe('first');
    expect(classifyName('ruby')).toBe('first'); // also a cool word
    expect(classifyName('amy')).toBe('first'); // 3 letters
  });
  test('cool words beat short', () => {
    expect(classifyName('ghost')).toBe('cool');
    expect(classifyName('widow')).toBe('cool');
    expect(classifyName('hex')).toBe('cool');
  });
  test('2–3 letters otherwise short; the rest tickers & other', () => {
    expect(classifyName('wtf')).toBe('short');
    expect(classifyName('xq')).toBe('short');
    expect(classifyName('asts')).toBe('other');
    expect(classifyName('x')).toBe('other');
  });
});

describe('tierUsd', () => {
  test('length tiers override category for 4 letters or fewer', () => {
    expect(tierUsd('xq')).toBe(60);
    expect(tierUsd('wtf')).toBe(50);
    expect(tierUsd('mary')).toBe(40);
    expect(tierUsd('asts')).toBe(40);
  });
  test('5+ letters keep category prices', () => {
    expect(tierUsd('maria')).toBe(NAME_TIERS.category.first);
    expect(tierUsd('ghost')).toBe(NAME_TIERS.category.cool);
    expect(tierUsd('tesla')).toBe(NAME_TIERS.category.brand);
    expect(tierUsd('agnccc')).toBe(NAME_TIERS.category.other);
  });
  test('unpriced 1-letter slot falls back to category', () => {
    expect(NAME_TIERS.byLength[1]).toBeNull();
    expect(tierUsd('x')).toBe(NAME_TIERS.category.other);
  });
});

describe('sorting, counting, relisting report', () => {
  test('sorts by category then name', () => {
    const s = sortByCategory([
      { name: 'asts' },
      { name: 'wtf' },
      { name: 'ghost' },
      { name: 'mary' },
      { name: 'john' },
    ]);
    expect(s.map((x) => x.name)).toEqual(['john', 'mary', 'ghost', 'wtf', 'asts']);
  });
  test('counts', () => {
    expect(countByCategory(['mary', 'ghost', 'tesla', 'wtf', 'asts'])).toEqual({
      first: 1,
      cool: 1,
      brand: 1,
      short: 1,
      other: 1,
    });
  });
  test('relistCount flags prices away from tier', () => {
    // rate 20 USD/BSV: $40 = 2 BSV = 200,000,000 sats
    const list = [
      { name: 'mary', priceSats: 200_000_000 },
      { name: 'asts', priceSats: 25_000_000 },
    ];
    expect(relistCount(list, 20)).toBe(1);
    expect(relistCount(list, 0)).toBe(0);
  });
});
