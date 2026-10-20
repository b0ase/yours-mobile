import { describe, expect, test } from 'bun:test';
import { readCollapsed, writeCollapsed } from './collapse';

const fake = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('collapsible home panels', () => {
  test('open by default, remembers a fold, and remembers opening again', () => {
    const s = fake();
    expect(readCollapsed('showcase', s)).toBe(false);
    writeCollapsed('showcase', true, s);
    expect(readCollapsed('showcase', s)).toBe(true);
    writeCollapsed('showcase', false, s);
    expect(readCollapsed('showcase', s)).toBe(false);
  });

  test('each panel is remembered on its own', () => {
    const s = fake();
    writeCollapsed('price', true, s);
    expect(readCollapsed('price', s)).toBe(true);
    expect(readCollapsed('showcase', s)).toBe(false);
  });

  test('blocked or throwing storage never breaks a panel: it just stays open', () => {
    const bad = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readCollapsed('showcase', bad)).toBe(false);
    expect(() => writeCollapsed('showcase', true, bad)).not.toThrow();
    expect(readCollapsed('showcase', null)).toBe(false);
    expect(() => writeCollapsed('showcase', true, null)).not.toThrow();
  });
});
