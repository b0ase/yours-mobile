import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { splashScript, B_SVG } from '../mobile/theme/splash';
import { B_OUTLINE_OUTER } from '../mobile/brand/bOutline';

const web = readFileSync(new URL('../../vite.config.web.ts', import.meta.url), 'utf8');
const themes = readFileSync(new URL('../themes.css', import.meta.url), 'utf8');
const png = (f: string) => readFileSync(new URL(`./themes/${f}`, import.meta.url));

describe('edition entry pages (web.bwalletx.com/white …)', () => {
  test('head: edition icon, status bar style and the page colour before first paint', () => {
    expect(web).toContain('<link rel="apple-touch-icon" href="/themes/${id}/icon-180.png" />');
    expect(web).toContain('apple-mobile-web-app-status-bar-style');
    expect(web).toContain('`    <style>html,body{background:${THEME_INSTALLS[id]}}</style>`');
  });
  test('White icons are the clean outline b on full-bleed white (regenerated from b-tile-paper.svg)', () => {
    for (const s of [180, 192, 512]) {
      const b = png(`icon-white-${s}.png`);
      expect(b.readUInt32BE(16)).toBe(s);
      expect(b.length).toBeGreaterThan(1000);
    }
  });
  test('splash draws the new outline b and honours the edition path before the saved pack', () => {
    expect(B_SVG).toContain(B_OUTLINE_OUTER);
    expect(B_SVG).not.toContain('polygon');
    const js = splashScript();
    expect(js).toContain('"white"');
    expect(js).toContain('location.pathname');
  });
  test('paper: unlock button black, autofill readable, web banner on the paper', () => {
    expect(themes).toContain(':root[data-bw-paper] .bw-unlock-btn');
    expect(themes).toContain('-webkit-autofill');
    expect(themes).toContain(':root[data-bw-paper] .bwallet-web-banner');
  });
});
