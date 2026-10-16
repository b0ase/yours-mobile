import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { accentById } from '../theme/accents';
import { PATTERNS, patternSvg } from './cardPatterns';
import { LIGHT_GROUND, LIGHT_MAX_OPACITY, LIGHT_PATTERNS, lightPatternSvg } from './cardPatternsLight';

test('White designs: 12 originals, listed in Design your card, light ground, faint ink only', () => {
  expect(LIGHT_PATTERNS.length).toBe(12);
  for (const p of LIGHT_PATTERNS) {
    expect(PATTERNS.some((x) => x.id === p.id)).toBe(true);
    const svg = lightPatternSvg(p.id, '#000000');
    expect(patternSvg(p.id, '#000000')).toBe(svg);
    expect(svg).toContain(`fill="${LIGHT_GROUND}"`);
    expect(svg.length).toBeLessThan(40_000);
    const ops = [...svg.matchAll(/(?:stroke|fill|stop)-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) expect(o).toBeLessThanOrEqual(LIGHT_MAX_OPACITY);
  }
});

test('White theme: black ink, light grounds, a white design by default', () => {
  const w = accentById('white');
  expect(w.accent).toBe('#000000');
  expect(w.on).toBe('#FFFFFF');
  expect(LIGHT_PATTERNS.some((p) => p.id === w.pattern)).toBe(true);
});

test('No dark cards on White: hard-coded dark fills are swept in themes.css', () => {
  const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
  for (const rgb of ['42, 33, 0', '11, 12, 15', '42, 20, 8', '23, 25, 30']) expect(css).toContain(`rgb(${rgb})`);
  for (const cls of ['.bw-mail-card', '.bw-swipe-action', '.askb-chips', '.bw-bc']) expect(css).toContain(cls);
});

test('Light packs: typed text in inputs takes the pack ink (no white on white)', () => {
  const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
  expect(css).toMatch(
    /data-bw-pack='light'\][^{]*textarea[^{]*\{[^}]*color: var\(--bw-text\) !important;[^}]*-webkit-text-fill-color: var\(--bw-text\)/,
  );
});

test('No dark cards on White: every dark hex in src/ has a mono sweep selector (run bun scripts/dark-fills.ts)', async () => {
  const { darkFills, renderBlock } = await import('../../../scripts/dark-fills');
  const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
  const fills = darkFills(new URL('../../', import.meta.url).pathname);
  // New lock's "start small" card (#2a1d00), Pots/Subscriptions panels (#17191E), Launchpad (#0F1013) and friends.
  for (const c of ['42, 29, 0', '23, 25, 30', '15, 16, 19', '11, 12, 15']) expect(fills).toContain(c);
  const missing = fills.filter((c) => !css.includes(`[style*='background: rgb(${c})']`));
  expect(missing).toEqual([]);
  expect(css).toContain(renderBlock(fills));
});
