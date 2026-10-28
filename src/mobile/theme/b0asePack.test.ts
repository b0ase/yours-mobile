import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { accentById } from './accents';
import { builtinPackForSite } from './themeSites';

describe('b0ase built-in pack', () => {
  test('has the approved colours and type', () => {
    const a = accentById('b0ase');
    expect(a.id).toBe('b0ase');
    expect(a.kind).toBe('theme');
    expect(a.blurb).toBe('Techy black, slanted buttons');
    expect([a.accent, a.on, a.bg, a.surface, a.surface2, a.line]).toEqual([
      '#FFFFFF',
      '#000000',
      '#000000',
      '#0A0A0A',
      '#121212',
      '#262626',
    ]);
    expect(a.radius).toBe('5px');
    expect(a.fontHead).toContain('Mono');
  });
  test('b0ase.com maps to the built-in pack; other sites do not', () => {
    expect(builtinPackForSite('b0ase')).toBe('b0ase');
    expect(builtinPackForSite('site-b0ase')).toBe('b0ase');
    expect(builtinPackForSite('https://b0ase.com')).toBe('b0ase');
    expect(builtinPackForSite('https://www.b0ase.com/x')).toBe('b0ase');
    expect(builtinPackForSite('site-bmarketx')).toBeNull();
    expect(builtinPackForSite('https://bmarketx.com')).toBeNull();
    expect(builtinPackForSite('https://b0ase.com.evil.example')).toBeNull();
  });
  test('themes.css draws the slanted shape on ::before for the main buttons', () => {
    const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
    expect(css).toContain(":root[data-bw-theme='b0ase'] .bw-pill-gold::before");
    expect(css).toContain('transform: skewX(-14deg)');
  });
});
