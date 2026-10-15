import { describe, expect, test } from 'bun:test';
import { PATTERNS, patternSvg, patternUri } from './cardPatterns';
import { THEMES, accentById } from '../theme/accents';

describe('card patterns', () => {
  test('every pattern is valid, card-sized SVG with no NaN and no external refs', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(8);
    for (const p of PATTERNS) {
      const svg = patternSvg(p.id, '#F5B800');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1011" height="637"')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).not.toContain('NaN');
      expect(svg).not.toMatch(/href=|url\((?!#)/);
      expect(svg.length).toBeGreaterThan(300);
    }
  });
  test('follows the accent colour it is given', () => {
    const violet = accentById('violet').accent;
    for (const p of PATTERNS) expect(patternSvg(p.id, violet)).toContain(violet);
    expect(patternUri('hex', violet)).toContain(encodeURIComponent(violet));
  });
  test('each theme suggests a real pattern', () => {
    for (const t of THEMES) expect(PATTERNS.some((p) => p.id === t.pattern)).toBe(true);
  });
});
