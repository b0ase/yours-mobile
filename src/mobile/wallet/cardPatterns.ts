import type { CardPatternId } from '../theme/accents';
import { hexToHsl, hslToHex, mix } from '../theme/colour';
import { LIGHT_PATTERNS, isLightPattern, lightPatternSvg } from './cardPatternsLight';

/**
 * Card patterns (Design your card › Patterns, owner 14 Oct 2026): for people with no picture they want to use.
 * Parametric SVG drawn here (no assets), at 3x the card (1011 × 637) so it stays crisp. One colour on a dark
 * ground; "Follow theme colour" passes the current accent, otherwise a fixed colour from the curated palette.
 */
export const PATTERN_W = 1011;
export const PATTERN_H = 637;

export const PATTERNS: readonly { id: CardPatternId; label: string }[] = [
  { id: 'topo', label: 'Rings' },
  { id: 'guilloche', label: 'Guilloche' },
  { id: 'cypher', label: 'Cyphertext' },
  { id: 'clouds', label: 'Clouds' },
  { id: 'waves', label: 'Waves' },
  { id: 'hex', label: 'Hex' },
  { id: 'stripes', label: 'Stripes' },
  { id: 'halftone', label: 'Halftone' },
  { id: 'circuit', label: 'Circuit' },
  { id: 'chevron', label: 'Chevrons' },
  { id: 'starburst', label: 'Starburst' },
  // White designs (cardPatternsLight.ts): off-white modernist studies for the White theme.
  ...LIGHT_PATTERNS,
];

const W = PATTERN_W;
const H = PATTERN_H;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Small seeded generator so a pattern is the same every time. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function body(id: CardPatternId, c: string): string {
  const out: string[] = [];
  switch (id) {
    case 'topo': {
      for (const [cx, cy, n] of [
        [W * 0.78, H * 0.3, 16],
        [W * 0.15, H * 0.95, 10],
      ] as const)
        for (let i = 1; i <= n; i++) {
          const r = i * 26;
          const wob = (k: number) => r + Math.sin(k * 3 + i) * i * 1.6;
          const pts = Array.from({ length: 49 }, (_, k) => {
            const a = (k / 48) * Math.PI * 2;
            return `${r1(cx + Math.cos(a) * wob(a))},${r1(cy + Math.sin(a) * wob(a) * 0.82)}`;
          });
          out.push(
            `<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2" opacity="${r1(1 - i / (n + 4))}"/>`,
          );
        }
      break;
    }
    case 'guilloche': {
      for (let j = 0; j < 14; j++) {
        const pts = Array.from({ length: 361 }, (_, k) => {
          const t = (k / 360) * Math.PI * 2;
          const R = 230 + j * 6;
          const rr = R + 42 * Math.sin(12 * t + j * 0.45);
          return `${r1(W * 0.66 + Math.cos(t) * rr)},${r1(H / 2 + Math.sin(t) * rr * 0.62)}`;
        });
        out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.7"/>`);
      }
      break;
    }
    case 'cypher': {
      const r = rng(7);
      const glyphs = '01ｱｲｳｴｵｶｷｸｹｺ$#*+<>=/\\|';
      for (let x = 12; x < W; x += 26) {
        const start = Math.floor(r() * 20);
        const len = 6 + Math.floor(r() * 16);
        for (let k = 0; k < len; k++) {
          const y = (start + k) * 30;
          if (y > H + 20) break;
          const g = glyphs[Math.floor(r() * glyphs.length)] as string;
          const op = r1(0.15 + (k / len) * 0.85);
          out.push(
            `<text x="${x}" y="${y}" fill="${c}" opacity="${op}" font-family="monospace" font-size="24">${g.replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[m] as string)}</text>`,
          );
        }
      }
      break;
    }
    case 'clouds': {
      const cloud = (x: number, y: number, s: number) =>
        `<path transform="translate(${x} ${y}) scale(${s})" d="M0 40h80a20 20 0 0 0 0-40 30 30 0 0 0-55-10A20 20 0 0 0 0 40z" fill="${c}" opacity="0.55"/>`;
      const star = (x: number, y: number, s: number) =>
        `<path transform="translate(${x} ${y}) scale(${s})" d="M0-12l3 8 9 1-7 6 2 9-7-5-7 5 2-9-7-6 9-1z" fill="${c}" opacity="0.8"/>`;
      out.push(cloud(620, 120, 1.6), cloud(110, 470, 1.2), cloud(820, 430, 1.1), cloud(330, 70, 0.8));
      for (const [x, y, s] of [
        [540, 300, 1.4],
        [900, 90, 1],
        [240, 300, 0.9],
        [700, 560, 1.2],
        [80, 120, 0.8],
      ] as const)
        out.push(star(x, y, s));
      for (let i = 0; i < 4; i++)
        out.push(
          `<path d="M${560 + i * 22} 637a${220 - i * 22} ${220 - i * 22} 0 0 1 ${440 - i * 44} 0" fill="none" stroke="${c}" stroke-width="14" opacity="${r1(0.25 + i * 0.15)}"/>`,
        );
      break;
    }
    case 'waves':
      for (let y = 0; y < H + 40; y += 28) {
        let d = `M0 ${y}`;
        for (let x = 0; x <= W; x += 40) d += ` Q${x + 20} ${(x / 40) % 2 === 0 ? y - 14 : y + 14} ${x + 40} ${y}`;
        out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="2" opacity="0.5"/>`);
      }
      break;
    case 'hex': {
      const s = 34;
      const hw = Math.sqrt(3) * s;
      for (let row = 0, y = 0; y < H + s; row++, y += s * 1.5)
        for (let x = row % 2 ? hw / 2 : 0; x < W + hw; x += hw) {
          const pts = Array.from({ length: 6 }, (_, k) => {
            const a = (Math.PI / 3) * k + Math.PI / 6;
            return `${r1(x + Math.cos(a) * s)},${r1(y + Math.sin(a) * s)}`;
          });
          out.push(`<polygon points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="1.6" opacity="0.45"/>`);
        }
      break;
    }
    case 'stripes':
      for (let x = -H; x < W; x += 36)
        out.push(`<path d="M${x} ${H}L${x + H} 0" stroke="${c}" stroke-width="10" opacity="0.32"/>`);
      break;
    case 'halftone':
      for (let y = 10; y < H; y += 22)
        for (let x = 10; x < W; x += 22) {
          const r = 1 + 8 * Math.max(0, 1 - Math.hypot(x - W * 0.8, y - H * 0.2) / 700);
          out.push(`<circle cx="${x}" cy="${y}" r="${r1(r)}" fill="${c}" opacity="0.7"/>`);
        }
      break;
    case 'circuit': {
      const r = rng(11);
      for (let i = 0; i < 46; i++) {
        let x = Math.round((r() * W) / 24) * 24;
        let y = Math.round((r() * H) / 24) * 24;
        let d = `M${x} ${y}`;
        for (let k = 0; k < 4; k++) {
          if (r() < 0.5) x += (r() < 0.5 ? -1 : 1) * 24 * (2 + Math.floor(r() * 4));
          else y += (r() < 0.5 ? -1 : 1) * 24 * (2 + Math.floor(r() * 3));
          d += ` L${x} ${y}`;
        }
        out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="2.4" opacity="0.5"/>`);
        out.push(`<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${c}" stroke-width="2.4" opacity="0.8"/>`);
      }
      break;
    }
    case 'chevron':
      for (let y = -40; y < H + 40; y += 44) {
        let d = `M0 ${y}`;
        for (let x = 0; x <= W; x += 60) d += ` L${x + 30} ${y + 26} L${x + 60} ${y}`;
        out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="5" opacity="0.38"/>`);
      }
      break;
    case 'starburst':
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const cx = W * 0.75;
        const cy = H * 0.3;
        out.push(
          `<path d="M${cx} ${cy}L${r1(cx + Math.cos(a) * 1200)} ${r1(cy + Math.sin(a) * 1200)}" stroke="${c}" stroke-width="${i % 2 ? 2 : 5}" opacity="0.35"/>`,
        );
      }
      break;
  }
  return out.join('');
}

/**
 * Art direction per pattern (owner, 15 Oct 2026: "every card design attractive in its own way, not recolours").
 * Each pattern gets its own ground, finish and light: banknote engraving with a foil band, neon with scanlines,
 * a holographic wave foil, brushed carbon, deco gold-leaf, enamel sunburst, risograph halftone and so on. All of
 * it is derived from the one colour passed in, so "Follow theme colour" still works and gold stays gold.
 */
type Finish = { ground: string; defs: string; under?: string; over: string; g?: string };

const dk = (c: string, t: number) => mix(c, '#000000', t);
const lt = (c: string, t: number) => mix(c, '#FFFFFF', t);
const shiftHue = (c: string, d: number) => {
  const h = hexToHsl(c);
  return hslToHex({ ...h, h: h.h + d, s: Math.max(h.s, 55) });
};
const GRAIN = (o: number) =>
  `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${o} 0"/></filter>`;
const grainRect = `<rect width="${W}" height="${H}" filter="url(#grain)"/>`;
const VIGNETTE = `<radialGradient id="vig" cx="50%" cy="45%" r="75%"><stop offset="60%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.55"/></radialGradient>`;
const vigRect = `<rect width="${W}" height="${H}" fill="url(#vig)"/>`;
const SHEEN = (a: string, o = 0.35) =>
  `<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0.3" stop-color="${a}" stop-opacity="0"/><stop offset="0.48" stop-color="${a}" stop-opacity="${o}"/><stop offset="0.52" stop-color="#fff" stop-opacity="${o * 0.8}"/><stop offset="0.7" stop-color="${a}" stop-opacity="0"/></linearGradient>`;
const sheenRect = `<rect width="${W}" height="${H}" fill="url(#sheen)"/>`;
const EDGE = `<rect x="3" y="3" width="${W - 6}" height="${H - 6}" rx="38" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="3"/>`;

function finish(id: CardPatternId, c: string): Finish {
  switch (id) {
    case 'topo': // Satin night with contour lines lit from the top right.
      return {
        ground: `<radialGradient id="gr" cx="80%" cy="20%" r="95%"><stop offset="0" stop-color="${dk(c, 0.62)}"/><stop offset="1" stop-color="${dk(c, 0.95)}"/></radialGradient>`,
        defs: VIGNETTE + SHEEN(c, 0.18) + GRAIN(0.05),
        over: sheenRect + vigRect + grainRect + EDGE,
      };
    case 'guilloche': // Banknote: cream-on-ink engraving, a foil security band and microtext border.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dk(c, 0.82)}"/><stop offset="1" stop-color="${dk(c, 0.93)}"/></linearGradient>`,
        defs:
          `<linearGradient id="foil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lt(c, 0.55)}"/><stop offset="0.5" stop-color="${c}"/><stop offset="1" stop-color="${dk(c, 0.35)}"/></linearGradient>` +
          GRAIN(0.06),
        over:
          `<rect x="${W * 0.86}" y="0" width="38" height="${H}" fill="url(#foil)" opacity="0.85"/>` +
          `<rect x="${W * 0.86 + 6}" y="0" width="2" height="${H}" fill="#fff" opacity="0.5"/>` +
          `<rect x="22" y="22" width="${W - 44}" height="${H - 44}" rx="26" fill="none" stroke="${c}" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="2 4"/>` +
          grainRect +
          EDGE,
      };
    case 'cypher': // Neon rain: glow filter and CRT scanlines.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dk(c, 0.9)}"/><stop offset="1" stop-color="#020203"/></linearGradient>`,
        defs:
          `<filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
          `<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="#000" opacity="0.35"/></pattern>` +
          VIGNETTE,
        g: 'filter="url(#glow)"',
        over: `<rect width="${W}" height="${H}" fill="url(#scan)"/>` + vigRect + EDGE,
      };
    case 'clouds': // Dreamy dusk sky, soft and bright, with paper grain.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dk(shiftHue(c, 200), 0.55)}"/><stop offset="0.6" stop-color="${dk(c, 0.45)}"/><stop offset="1" stop-color="${dk(shiftHue(c, -30), 0.3)}"/></linearGradient>`,
        defs: GRAIN(0.08) + SHEEN('#ffffff', 0.12),
        over: sheenRect + grainRect + EDGE,
      };
    case 'waves': // Holographic foil: rainbow sheen that shifts across the waves.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="1" y2="0.6"><stop offset="0" stop-color="${dk(c, 0.7)}"/><stop offset="1" stop-color="${dk(shiftHue(c, 60), 0.75)}"/></linearGradient>`,
        defs:
          `<linearGradient id="holo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shiftHue(c, -60)}" stop-opacity="0.35"/><stop offset="0.25" stop-color="${shiftHue(c, 40)}" stop-opacity="0.12"/><stop offset="0.5" stop-color="${shiftHue(c, 140)}" stop-opacity="0.32"/><stop offset="0.75" stop-color="${shiftHue(c, 220)}" stop-opacity="0.12"/><stop offset="1" stop-color="${c}" stop-opacity="0.35"/></linearGradient>` +
          SHEEN('#ffffff', 0.25),
        over: `<rect width="${W}" height="${H}" fill="url(#holo)" style="mix-blend-mode:screen"/>` + sheenRect + EDGE,
      };
    case 'hex': // Carbon fibre: woven dark ground with a hard specular stripe.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1A1B1F"/><stop offset="1" stop-color="#050506"/></linearGradient>`,
        defs:
          `<pattern id="weave" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#fff" opacity="0.04"/><rect x="6" y="6" width="6" height="6" fill="#fff" opacity="0.04"/></pattern>` +
          SHEEN(c, 0.28),
        under: `<rect width="${W}" height="${H}" fill="url(#weave)"/>`,
        over: sheenRect + EDGE,
      };
    case 'stripes': // Racing livery: deep lacquer, bold metallic stripes, clear coat.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dk(c, 0.55)}"/><stop offset="1" stop-color="${dk(c, 0.88)}"/></linearGradient>`,
        defs:
          `<linearGradient id="coat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
          VIGNETTE,
        over: `<rect width="${W}" height="${H * 0.5}" fill="url(#coat)"/>` + vigRect + EDGE,
      };
    case 'halftone': // Risograph pop: warm paper tone, offset second ink.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${dk(shiftHue(c, 180), 0.7)}"/><stop offset="1" stop-color="${dk(c, 0.85)}"/></linearGradient>`,
        defs: GRAIN(0.1),
        under: `<g transform="translate(7 5)" opacity="0.5">${body('halftone', shiftHue(c, 180))}</g>`,
        over: grainRect + EDGE,
      };
    case 'circuit': // PCB: solder-mask green-black, copper traces glowing at the pads.
      return {
        ground: `<radialGradient id="gr" cx="30%" cy="30%" r="90%"><stop offset="0" stop-color="${dk(shiftHue(c, 150), 0.78)}"/><stop offset="1" stop-color="#030605"/></radialGradient>`,
        defs:
          `<filter id="glow"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
          `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.2" fill="#fff" opacity="0.08"/></pattern>` +
          VIGNETTE,
        under: `<rect width="${W}" height="${H}" fill="url(#dots)"/>`,
        g: 'filter="url(#glow)"',
        over: vigRect + EDGE,
      };
    case 'chevron': // Art deco: black lacquer, gold-leaf chevrons, a deco fan and double rule frame.
      return {
        ground: `<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121212"/><stop offset="1" stop-color="#050505"/></linearGradient>`,
        defs:
          `<linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${lt(c, 0.45)}"/><stop offset="0.5" stop-color="${c}"/><stop offset="1" stop-color="${dk(c, 0.4)}"/></linearGradient>` +
          SHEEN(c, 0.2),
        over:
          Array.from(
            { length: 9 },
            (_, i) =>
              `<path d="M${W / 2} ${H + 10} L${r1(W / 2 + Math.cos(Math.PI + (i + 1) * (Math.PI / 10)) * 260)} ${r1(H + 10 + Math.sin(Math.PI + (i + 1) * (Math.PI / 10)) * 260)}" stroke="url(#leaf)" stroke-width="3" opacity="0.8"/>`,
          ).join('') +
          `<rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="24" fill="none" stroke="url(#leaf)" stroke-width="3"/>` +
          `<rect x="30" y="30" width="${W - 60}" height="${H - 60}" rx="16" fill="none" stroke="url(#leaf)" stroke-width="1.2"/>` +
          sheenRect,
      };
    case 'starburst': // Enamel sunburst: hot core fading to a deep rim, glossy glaze on top.
      return {
        ground: `<radialGradient id="gr" cx="75%" cy="30%" r="100%"><stop offset="0" stop-color="${lt(c, 0.1)}"/><stop offset="0.35" stop-color="${dk(c, 0.35)}"/><stop offset="1" stop-color="${dk(shiftHue(c, -40), 0.88)}"/></radialGradient>`,
        defs:
          `<linearGradient id="glaze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.25"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
          VIGNETTE,
        over: `<rect width="${W}" height="${H}" fill="url(#glaze)"/>` + vigRect + EDGE,
      };
    default: // White designs draw their own ground (cardPatternsLight.ts).
      return { ground: '', defs: '', over: '' };
  }
}

/** The pattern as an SVG string: the pattern in `colour` on its own art-directed ground and finish. */
export function patternSvg(id: CardPatternId, colour: string): string {
  if (isLightPattern(id)) return lightPatternSvg(id, colour);
  const f = finish(id, colour);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${f.ground}${f.defs}</defs><rect width="${W}" height="${H}" fill="url(#gr)"/>${f.under ?? ''}` +
    `<g ${f.g ?? ''}>${body(id, colour)}</g>${f.over}</svg>`
  );
}

const cache = new Map<string, string>();
export function patternUri(id: CardPatternId, colour: string): string {
  const k = id + colour;
  let u = cache.get(k);
  if (!u) {
    u = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(patternSvg(id, colour));
    cache.set(k, u);
  }
  return u;
}
