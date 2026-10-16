import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MENU_HINT_OPENS, countMenuOpen, menuOpens, showMenuHint } from './menuHint';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('menu avatar ☰ hint', () => {
  test('shows until the menu has been opened 3 times', () => {
    const s = mem();
    expect(MENU_HINT_OPENS).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(showMenuHint(s)).toBe(true);
      countMenuOpen(s);
    }
    expect(showMenuHint(s)).toBe(false);
    countMenuOpen(s);
    expect(menuOpens(s)).toBe(3);
  });
  test('blocked or broken storage never throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(showMenuHint(bad)).toBe(true);
    expect(() => countMenuOpen(bad)).not.toThrow();
    expect(showMenuHint(null)).toBe(true);
  });
  test('the button is labelled and uses no router hooks', () => {
    const src = readFileSync(join(import.meta.dir, 'MenuAvatarButton.tsx'), 'utf8');
    expect(src).toContain('aria-label="Menu and account"');
    expect(src).toContain('AccountAvatar');
    expect(src.match(/\buse(Location|Navigate|SearchParams|Params|Href|Match|NavigationType)\(/)).toBeNull();
  });
});
