import type { CardPatternId } from '../theme/accents';

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

/** The pattern as an SVG string: colour `colour` on a near-black ground. */
export function patternSvg(id: CardPatternId, colour: string, ground = '#050506'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${ground}"/>${body(id, colour)}</svg>`;
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
