import type { CardPatternId } from '../theme/accents';

/**
 * White card art (owner, 16 Oct 2026: "MoMA New York modern art, white, minimalistic"): original modernist studies
 * drawn here as SVG (no images, no copyrighted works). Each sits on an off-white ground and draws in the given
 * colour at very low opacity, so black text on top keeps AA (cardPatterns.test.ts checks the darkest ink).
 */
export const LIGHT_PATTERN_IDS = [
  'grid',
  'field',
  'bauhaus',
  'lines',
  'fold',
  'brush',
  'paper',
  'squares',
  'arcs',
  'dotgrid',
  'horizon',
  'contour',
] as const satisfies readonly CardPatternId[];
export type LightPatternId = (typeof LIGHT_PATTERN_IDS)[number];

export const LIGHT_PATTERNS: readonly { id: LightPatternId; label: string }[] = [
  { id: 'grid', label: 'Grid study' },
  { id: 'field', label: 'Soft circle' },
  { id: 'bauhaus', label: 'Bauhaus' },
  { id: 'lines', label: 'Line study' },
  { id: 'fold', label: 'Paper fold' },
  { id: 'brush', label: 'Ink stroke' },
  { id: 'paper', label: 'Paper' },
  { id: 'squares', label: 'Squares' },
  { id: 'arcs', label: 'Arcs' },
  { id: 'dotgrid', label: 'Dot grid' },
  { id: 'horizon', label: 'Two fields' },
  { id: 'contour', label: 'Contour' },
];

export const isLightPattern = (id: string): id is LightPatternId =>
  (LIGHT_PATTERN_IDS as readonly string[]).includes(id);

/** Highest ink opacity used anywhere in these designs (the AA guard in the tests uses it). */
export const LIGHT_MAX_OPACITY = 0.12;
export const LIGHT_GROUND = '#FAFAF7';

const W = 1011;
const H = 637;
const r1 = (n: number) => Math.round(n * 10) / 10;
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function art(id: LightPatternId, c: string): string {
  const ln = (o: number, w = 2) => `fill="none" stroke="${c}" stroke-opacity="${o}" stroke-width="${w}"`;
  const fl = (o: number) => `fill="${c}" fill-opacity="${o}"`;
  switch (id) {
    case 'grid': // Mondrian-like: faint black lines, a few pale blocks.
      return (
        `<rect x="0" y="0" width="360" height="250" ${fl(0.05)}/><rect x="760" y="430" width="251" height="207" ${fl(0.04)}/>` +
        `<rect x="560" y="0" width="200" height="140" ${fl(0.03)}/>` +
        [360, 560, 760].map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${H}" ${ln(0.1, 5)}/>`).join('') +
        [140, 250, 430].map((y) => `<line x1="0" y1="${y}" x2="${W}" y2="${y}" ${ln(0.1, 5)}/>`).join('')
      );
    case 'field': // A single soft circle in a light field.
      return `<defs><radialGradient id="lf"><stop offset="0" stop-color="${c}" stop-opacity="0.08"/><stop offset="0.7" stop-color="${c}" stop-opacity="0.04"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs><circle cx="740" cy="250" r="300" fill="url(#lf)"/><circle cx="740" cy="250" r="190" ${ln(0.06, 1.5)}/>`;
    case 'bauhaus': // Circle, square, triangle.
      return (
        `<circle cx="780" cy="200" r="130" ${fl(0.06)}/><rect x="620" y="360" width="190" height="190" ${fl(0.04)}/>` +
        `<path d="M860 560 L990 330 L990 560 Z" ${fl(0.07)}/><line x1="560" y1="80" x2="560" y2="600" ${ln(0.08, 3)}/>`
      );
    case 'lines': // Line study: verticals of varying weight.
      return Array.from({ length: 34 }, (_, i) => {
        const x = 480 + i * 16;
        return `<line x1="${x}" y1="${60 + (i % 5) * 20}" x2="${x}" y2="${H - 60 - (i % 7) * 18}" ${ln(0.04 + (i % 4) * 0.02, 1 + (i % 3))}/>`;
      }).join('');
    case 'fold': // Folded paper: two planes and their crease shadows.
      return `<defs><linearGradient id="lfa" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}" stop-opacity="0.08"/></linearGradient><linearGradient id="lfb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="0.07"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><path d="M0 0 L620 0 L420 ${H} L0 ${H} Z" fill="url(#lfa)"/><path d="M620 0 L${W} 0 L${W} ${H} L420 ${H} Z" fill="url(#lfb)"/><line x1="620" y1="0" x2="420" y2="${H}" ${ln(0.1, 1.5)}/>`;
    case 'brush': // One calligraphic ink sweep.
      return `<path d="M470 470 C 560 300, 760 220, 930 250 C 960 256, 975 270, 960 282 C 800 270, 640 340, 520 500 C 505 520, 470 505, 470 470 Z" ${fl(0.09)}/><path d="M500 488 C 600 360, 760 290, 900 278" ${ln(0.05, 2)}/>`;
    case 'paper': {
      // Off-white texture: fine seeded fibres.
      const r = rng(7);
      return Array.from({ length: 220 }, () => {
        const x = r() * W;
        const y = r() * H;
        const a = r() * Math.PI;
        const l = 6 + r() * 22;
        return `<line x1="${r1(x)}" y1="${r1(y)}" x2="${r1(x + Math.cos(a) * l)}" y2="${r1(y + Math.sin(a) * l)}" ${ln(0.04 + r() * 0.05, 1)}/>`;
      }).join('');
    }
    case 'squares': // Nested squares, Albers-like, off centre.
      return [300, 230, 160, 90]
        .map(
          (s, i) =>
            `<rect x="${r1(820 - s)}" y="${r1(330 - s + i * 18)}" width="${s * 2}" height="${s * 2}" ${fl(0.025)}/>`,
        )
        .join('');
    case 'arcs': // Concentric quarter arcs from a corner.
      return Array.from({ length: 9 }, (_, i) => {
        const rr = 120 + i * 60;
        return `<path d="M${W - rr} ${H} A ${rr} ${rr} 0 0 1 ${W} ${H - rr}" ${ln(0.05 + (i % 2) * 0.04, 2)}/>`;
      }).join('');
    case 'dotgrid': // Even dot grid fading out to the left.
      return Array.from({ length: 16 * 10 }, (_, k) => {
        const i = k % 16;
        const j = Math.floor(k / 16);
        return `<circle cx="${400 + i * 38}" cy="${80 + j * 54}" r="3.2" ${fl(r1((i / 15) * 0.12 * 100) / 100)}/>`;
      }).join('');
    case 'horizon': // Two quiet colour fields with a soft edge.
      return `<defs><filter id="lb"><feGaussianBlur stdDeviation="14"/></filter></defs><rect x="40" y="40" width="${W - 80}" height="260" rx="10" ${fl(0.05)} filter="url(#lb)"/><rect x="40" y="340" width="${W - 80}" height="257" rx="10" ${fl(0.03)} filter="url(#lb)"/>`;
    case 'contour': {
      // Wavy contour lines, a quiet landscape.
      return Array.from({ length: 12 }, (_, i) => {
        const y0 = 230 + i * 34;
        const pts = Array.from({ length: 41 }, (_, k) => {
          const x = (k / 40) * W;
          return `${r1(x)},${r1(y0 + Math.sin(k / 5 + i * 0.6) * (18 + i * 2))}`;
        });
        return `<polyline points="${pts.join(' ')}" ${ln(0.05 + (i % 3) * 0.02, 1.5)}/>`;
      }).join('');
    }
  }
}

/** A white design as a full SVG string (off-white ground + the study in `colour`). */
/** `ground` replaces the off-white for paper packs (Pink, Blue, Yellow), so their cards are the paper, never white. */
export function lightPatternSvg(id: LightPatternId, colour: string, ground: string = LIGHT_GROUND): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${ground}"/>${art(id, colour)}</svg>`
  );
}
