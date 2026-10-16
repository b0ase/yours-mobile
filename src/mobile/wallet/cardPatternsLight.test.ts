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
  const { darkFills, darkClasses, renderBlock } = await import('../../../scripts/dark-fills');
  const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
  const fills = darkFills(new URL('../../', import.meta.url).pathname);
  // New lock's "start small" card (#2a1d00), Pots/Subscriptions panels (#17191E), Launchpad (#0F1013) and friends.
  for (const c of ['42, 29, 0', '23, 25, 30', '15, 16, 19', '11, 12, 15']) expect(fills).toContain(c);
  const missing = fills.filter((c) => !css.includes(`[style*='background: rgb(${c})']`));
  expect(missing).toEqual([]);
  const classes = darkClasses(new URL('../../', import.meta.url).pathname);
  // Hidden tokens row hover, bChat tabs, sell sheets: Tailwind dark fills are swept too.
  for (const c of ['hover:bg-[#1f2128]', 'bg-[#2b2f36]', 'bg-[#0F1013]']) expect(classes).toContain(c);
  expect(css).toContain(renderBlock(fills, classes));
});

test('No dark cards on White: dark backgrounds in stylesheets have a pack override (Hidden tokens head, 16 Oct)', async () => {
  const { uncoveredDarkCss, strayBgBlack } = await import('../../../scripts/dark-fills');
  const src = new URL('../../', import.meta.url).pathname;
  // Fix: add a [data-bw-tone='mono'] rule in themes.css, or a CSS_KEEP reason (scrim, media stage) in dark-fills.ts.
  expect(uncoveredDarkCss(src)).toEqual([]);
  // Solid bg-black outside media letterboxes: use a dark hex so the mono sweep catches it.
  expect(strayBgBlack(src)).toEqual([]);
  const css = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
  expect(css).toMatch(/:root\[data-bw-tone='mono'\]\s*:is\(\s*\.bw-hid,\s*\.bw-hid-head/);
  // Feed: sort pill and selected chips are white pills with a dark outline on White and paper packs.
  expect(css).toMatch(
    /:is\(\.bw-feed-sort, \.bw-feed-chip\.is-on\) \{[^}]*background: var\(--bw-surface\) !important;[^}]*border: 1\.5px solid var\(--bw-text\)/,
  );
});

test('paper packs draw the White designs on their own paper shade, never the off-white ground', () => {
  for (const id of ['pink', 'blue', 'yellow'] as const) {
    const a = accentById(id);
    const svg = lightPatternSvg('arcs', a.accent, a.surface);
    expect(svg).toContain(`fill="${a.surface}"`);
    expect(svg).not.toContain(LIGHT_GROUND);
  }
});
