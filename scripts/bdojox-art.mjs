/**
 * bDojoX theme card art (19 Oct 2026). Matches bdojox.com: navy #070b1a, Dojo red #e0262f, blue #3a6bf0 / #7ea0ff,
 * and the site's own logo family (the 3D slanted torii and the forward-leaning katakana-style wordmark), copied
 * unchanged from bdojox-site (media-src/logo-gen.mjs output) into scripts/bdojox/. Writes webp via sharp:
 *   node scripts/bdojox-art.mjs
 *
 * Layout: WalletCard zooms edition art 1.4x toward the top-right (cardFrontArt.ts), so the card shows roughly
 * x 0-71% and y 29-100% of the art. The marks sit inside that window, right of the balance.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const W = 1011;
const H = 637;
const OUT = new URL('../src/mobile/wallet/editionArt/', import.meta.url);
const SRC = new URL('./bdojox/', import.meta.url);

/** One of the site's SVGs as a nested <svg> placed at x, y with width w (height follows its viewBox). */
function place(file, x, y, w) {
  const svg = readFileSync(new URL(file, SRC), 'utf8');
  const vb = /viewBox="([^"]+)"/.exec(svg)[1];
  const [, , vw, vh] = vb.split(/\s+/).map(Number);
  const h = (w * vh) / vw;
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="${vb}">${inner}</svg>`;
}

// Seeded random so the art is reproducible.
let s = 7;
const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;

/** Ensō: many thin arcs with drifting radius and a fading tail, read as a dry red brush stroke. */
function enso(cx, cy, r, start = -100, sweep = 330) {
  const out = [];
  for (let k = 0; k < 70; k++) {
    const off = (rnd() - 0.5) * 30;
    const a0 = start + rnd() * 6;
    const a1 = a0 + sweep - rnd() * (40 + Math.abs(off) * 2.2);
    const pts = [];
    for (let a = a0; a <= a1; a += 3) {
      const t = (a - a0) / (a1 - a0);
      const rr = r + off * (1 - 0.35 * t) + Math.sin(t * 9) * 3;
      const rad = (a * Math.PI) / 180;
      pts.push(`${(cx + rr * Math.cos(rad)).toFixed(1)} ${(cy + rr * Math.sin(rad)).toFixed(1)}`);
    }
    const w = (1.2 + rnd() * 3).toFixed(1);
    const o = (0.3 + rnd() * 0.45).toFixed(2);
    out.push(
      `<path d="M${pts.join('L')}" stroke="#e0262f" stroke-width="${w}" stroke-opacity="${o}" fill="none" stroke-linecap="round"/>`,
    );
  }
  return out.join('');
}

/** Belt rule in the site's colours. */
const BELTS = ['#ffffff', '#e0262f', '#3a6bf0', '#e0262f', '#7ea0ff'];
function beltRule(x, y, w, h) {
  const seg = w / BELTS.length;
  return BELTS.map(
    (c, i) =>
      `<rect x="${(x + i * seg).toFixed(1)}" y="${y}" width="${(seg - 3).toFixed(1)}" height="${h}" fill="${c}"/>`,
  ).join('');
}

const ground = `<defs>
<radialGradient id="navy" cx=".7" cy=".3" r="1"><stop offset="0" stop-color="#101a3a"/><stop offset=".55" stop-color="#070b1a"/><stop offset="1" stop-color="#03050d"/></radialGradient>
<radialGradient id="bluewash" cx=".55" cy=".45" r=".5"><stop offset="0" stop-color="#3a6bf0" stop-opacity=".22"/><stop offset="1" stop-color="#3a6bf0" stop-opacity="0"/></radialGradient>
</defs><rect width="${W}" height="${H}" fill="url(#navy)"/><rect width="${W}" height="${H}" fill="url(#bluewash)"/>`;

const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;

// Card 1: the site's lockup (torii + wordmark) with a belt rule.
const card1 = `${open}${ground}
${place('logo-lockup.svg', W * 0.355, H * 0.47, W * 0.31)}
${beltRule(W * 0.4, H * 0.66, 190, 5)}</svg>`;

// Card 2: the torii mark inside a red ensō, the wordmark beneath.
const card2 = `${open}${ground}
<g opacity=".55">${enso(W * 0.51, H * 0.44, 78, -60, 320)}</g>
${place('logo.svg', W * 0.51 - 52, H * 0.44 - 46, 104)}
${place('wordmark.svg', W * 0.44, H * 0.6, W * 0.15)}</svg>`;

for (const [name, svg] of [
  ['bdojox-card-1', card1],
  ['bdojox-card-2', card2],
]) {
  const out = new URL(`${name}.webp`, OUT).pathname;
  await sharp(Buffer.from(svg)).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log(out);
}
