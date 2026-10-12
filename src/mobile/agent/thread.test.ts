import { describe, expect, it } from 'bun:test';
import { loadThread, saveThread, screenContext } from './thread';

describe('Ask b shared thread', () => {
  it('is per account', () => {
    saveThread('a', [{ role: 'user', text: 'hi' }]);
    expect(loadThread('a')).toHaveLength(1);
    expect(loadThread('b')).toEqual([]);
    expect(loadThread(null)).toEqual([]);
  });
  it('names the screen', () => {
    expect(screenContext('/m/market/x')).toContain('"market"');
    expect(screenContext('/m')).toContain('"home"');
    expect(screenContext(undefined)).toBe('');
  });
});

import { IDEAS, shuffled } from './ideas';
describe('Ask b ideas', () => {
  it('has about 100, unique, no investment wording', () => {
    expect(IDEAS.length).toBeGreaterThan(80);
    expect(new Set(IDEAS.map((i) => i.label)).size).toBe(IDEAS.length);
    expect(IDEAS.some((i) => /invest|yield|return|profit/i.test(i.label))).toBe(false);
  });
  it('shuffles without losing any', () => {
    expect(shuffled([1, 2, 3]).sort()).toEqual([1, 2, 3]);
  });
});
