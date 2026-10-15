import { describe, expect, it } from 'bun:test';
import { bavatarSvg } from '../bavatar/bavatar';
import { tintColour, tintSvg } from './tint';

const KEY = '02' + 'ab'.repeat(32);

describe('accent tint', () => {
  it('leaves gold art untouched', () => {
    const svg = bavatarSvg(KEY, { size: 64 });
    expect(tintSvg(svg, 'gold')).toBe(svg);
    expect(tintSvg(svg, null)).toBe(svg);
  });
  it('moves gold onto the accent hue and keeps black/white', () => {
    const [r, g, b] = tintColour([245, 184, 0], '#B197FC');
    expect(b).toBeGreaterThan(g); // violet: blue over green
    expect(r).toBeGreaterThan(g);
    expect(tintColour([0, 0, 0], '#B197FC')).toEqual([0, 0, 0]);
    expect(tintColour([255, 255, 255], '#B197FC')).toEqual([255, 255, 255]);
    expect(tintColour([11, 10, 8], '#B197FC')).toEqual([11, 10, 8]);
  });
  it('a violet bAvatar has no gold left', () => {
    const out = tintSvg(bavatarSvg(KEY, { size: 64 }), 'violet');
    for (const g of ['#ffd24d', '#f2c230', '#e9b52a', '#d9a21a', '#c58b12']) expect(out.toLowerCase()).not.toContain(g);
    expect(out.startsWith('<svg')).toBe(true);
  });
});
