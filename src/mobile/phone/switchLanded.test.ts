import { describe, expect, test } from 'bun:test';

const mem = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const { hasLanded, SWITCH_LANDED_KEY } = await import('./pageEl?switchLanded' as string);

describe('an account switch reloads onto the Wallet, not Ask b (owner, 13 Nov 2026)', () => {
  test('a cold start has not landed; after a switch reload it has', () => {
    mem.clear();
    expect(hasLanded()).toBe(false);
    mem.set(SWITCH_LANDED_KEY, '1');
    expect(hasLanded()).toBe(true);
  });
});
