/**
 * bDojoX theme card art (19 Oct 2026, owner direction): deep navy/black base, our own red + blue torii, and a white
 * katakana-style wordmark (Latin letters drawn as katakana-like strokes, SVG paths, no font). Original geometry only:
 * no third-party dojo marks. Writes SVG then webp via sharp:
 *   node scripts/bdojox-art.mjs
 */
import sharp from 'sharp';

const W = 1011;
const H = 637;
const OUT = new URL('../src/mobile/wallet/editionArt/', import.meta.url);

// Seeded random so the art is reproducible.
let s = 7;
const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;

/** Ensō: many thin arcs with drifting radius and fading tail, read as a dry gold brush stroke. */
function enso(cx, cy, r, start = -100, sweep = 330) {
  const out = [];
  for (let k = 0; k < 70; k++) {
    const off = (rnd() - 0.5) * 34; // bristle spread
    const a0 = start + rnd() * 6;
    const a1 = a0 + sweep - rnd() * (40 + Math.abs(off) * 2.2); // outer bristles run dry sooner
    const pts = [];
    for (let a = a0; a <= a1; a += 3) {
      const t = (a - a0) / (a1 - a0);
      const rr = r + off * (1 - 0.35 * t) + Math.sin(t * 9) * 3;
      const rad = (a * Math.PI) / 180;
      pts.push(`${(cx + rr * Math.cos(rad)).toFixed(1)} ${(cy + rr * Math.sin(rad)).toFixed(1)}`);
    }
    const w = (1.4 + rnd() * 3.2).toFixed(1);
    const o = (0.35 + rnd() * 0.5).toFixed(2);
    out.push(
      `<path d="M${pts.join('L')}" stroke="url(#gold)" stroke-width="${w}" stroke-opacity="${o}" fill="none" stroke-linecap="round"/>`,
    );
  }
  return out.join('');
}

/** Torii: two pillars, kasagi (curved top beam) and nuki (tie beam), in gold leaf. */
function torii(x, y, w) {
  const h = w * 0.9;
  const p = w * 0.07;
  return `<g>
<path d="M${x - w * 0.62} ${y} Q${x} ${y + w * 0.08} ${x + w * 0.62} ${y} L${x + w * 0.56} ${y + w * 0.1} Q${x} ${y + w * 0.16} ${x - w * 0.56} ${y + w * 0.1} Z" fill="url(#gold)"/>
<rect fill="url(#gold)" x="${x - w * 0.5}" y="${y + w * 0.26}" width="${w}" height="${w * 0.06}"/>
<rect fill="url(#gold)" x="${x - p / 2}" y="${y + w * 0.12}" width="${p * 0.8}" height="${w * 0.15}"/>
<rect fill="url(#blue)" x="${x - w * 0.38}" y="${y + w * 0.1}" width="${p}" height="${h}"/>
<rect fill="url(#blue)" x="${x + w * 0.38 - p}" y="${y + w * 0.1}" width="${p}" height="${h}"/>
</g>`;
}

/** White katakana-style wordmark "bDOJOX": each letter is a few straight brush strokes (b≈ト+コ, D≈ワ, O≈ロ, J≈フ, X≈メ). */
const GLYPHS = {
  b: ['M8 0L4 80', 'M6 38L50 34L46 78L4 80'],
  D: ['M4 2L4 80', 'M4 2L54 4L50 44Q42 72 4 80'],
  O: ['M6 6L52 4L50 76L4 78Z'],
  J: ['M2 6L54 4L50 60Q44 78 14 80L6 64'],
  X: ['M8 4Q40 40 56 80', 'M54 10Q30 60 2 76'],
};
function wordmark(x, y, size) {
  const k = size / 80;
  const g = [];
  [...'bDOJOX'].forEach((ch, i) => {
    g.push(
      `<g transform="translate(${(x + i * 72 * k).toFixed(1)} ${y}) scale(${k.toFixed(3)}) skewX(-6)">${GLYPHS[ch]
        .map((d) => `<path d="${d}"/>`)
        .join('')}</g>`,
    );
  });
  return `<g fill="none" stroke="#FFFFFF" stroke-width="${(9).toFixed(0)}" stroke-linecap="square" stroke-linejoin="miter">${g.join('')}</g>`;
}

const BELTS = ['#FFFFFF', '#E5262E', '#2F7BFF', '#E5262E', '#2F7BFF'];
function beltRule(x, y, w, h) {
  const seg = w / BELTS.length;
  return BELTS.map(
    (c, i) =>
      `<rect x="${(x + i * seg).toFixed(1)}" y="${y}" width="${(seg - 3).toFixed(1)}" height="${h}" fill="${c}"/>`,
  ).join('');
}

const defs = `<defs>
<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF5A5F"/><stop offset=".45" stop-color="#E5262E"/><stop offset="1" stop-color="#B0151C"/></linearGradient>
<radialGradient id="lac" cx=".7" cy=".3" r="1"><stop offset="0" stop-color="#14254A"/><stop offset=".55" stop-color="#0A1430"/><stop offset="1" stop-color="#03060F"/></radialGradient>
<linearGradient id="blue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5EA2FF"/><stop offset="1" stop-color="#1F5FD6"/></linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF" stop-opacity=".06"/><stop offset=".35" stop-color="#FFF" stop-opacity="0"/></linearGradient>
</defs>`;

/** Faint lacquer grain: thin horizontal hairlines. */
function grain(w, h) {
  const out = [];
  for (let i = 0; i < 90; i++) {
    const y = (rnd() * h).toFixed(1);
    out.push(
      `<rect x="0" y="${y}" width="${w}" height="${(0.6 + rnd()).toFixed(1)}" fill="#7FA8FF" fill-opacity="${(0.015 + rnd() * 0.03).toFixed(3)}"/>`,
    );
  }
  return out.join('');
}

/* Layout note: WalletCard zooms edition art 1.4x toward the top-right (cardFrontArt.ts), so the card shows roughly
   x 0-71% and y 29-100% of the art. The torii and wordmark sit inside that window, right of the balance. */

// Card 1: the torii over the wordmark and a red/blue rule.
const card1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}
<rect width="${W}" height="${H}" fill="url(#lac)"/>${grain(W, H)}<rect width="${W}" height="${H}" fill="url(#sheen)"/>
${torii(W * 0.5, H * 0.335, 150)}
${wordmark(W * 0.405, H * 0.64, 36)}
${beltRule(W * 0.405, H * 0.735, 190, 5)}</svg>`;

// Card 2: a torii framed by a large faint ensō.
s = 21;
const card2 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}
<rect width="${W}" height="${H}" fill="url(#lac)"/>${grain(W, H)}<rect width="${W}" height="${H}" fill="url(#sheen)"/>
<g opacity=".45">${enso(W * 0.5, H * 0.5, 130, -60, 320)}</g>
${torii(W * 0.5, H * 0.35, 120)}
${wordmark(W * 0.405, H * 0.64, 36)}
${beltRule(W * 0.405, H * 0.735, 190, 5)}</svg>`;

for (const [name, svg] of [
  ['bdojox-card-1', card1],
  ['bdojox-card-2', card2],
]) {
  const out = new URL(`${name}.webp`, OUT).pathname;
  await sharp(Buffer.from(svg)).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log(out);
}
