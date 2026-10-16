import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8');
const PLAYER = ['MiniPlayer.tsx', 'stream/StreamAlbum.tsx', 'stream/FeaturedTracks.tsx', 'featured/StillsBanner.tsx'];
const css = readFileSync(join(import.meta.dir, '../../themes.css'), 'utf8');

test('player text uses theme tokens: no hard-coded white or grey ink', () => {
  for (const f of PLAYER) {
    const src = read(f);
    expect({ f, hits: src.match(/color="#fff"|text-\[#98A2B3\]|'#98A2B3'|'#2b2f36'|'#111216'/gi) }).toEqual({ f, hits: null });
  }
});

test('text-white is remapped to theme ink in packs, including over the stills banner on light packs', () => {
  expect(css).toMatch(/:root\[data-bw-pack\] \.text-white/);
  expect(css).toMatch(/:root\[data-bw-pack='light'\] \.bw-stills \.text-white \{\s*color: var\(--bw-text\)/);
  // the scrim under titles turns to paper on light packs, so ink is legible over (inverted) art
  expect(css).toMatch(/:root\[data-bw-pack='light'\] \.bw-stills-scrim \{[^}]*--bw-paper-rgb[^}]*0\.92/);
  expect(css).toMatch(/:root\[data-bw-theme='white'\] \.bw-stills-img \{\s*filter: invert\(1\)/);
  const banner = read('featured/StillsBanner.tsx');
  for (const c of ['bw-stills ', 'bw-stills-img', 'bw-stills-scrim']) expect(banner).toContain(c);
});
