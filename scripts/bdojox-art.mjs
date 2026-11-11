/**
 * bDojoX theme card art (19 Oct 2026). Matches bdojox.com: navy #070b1a, Dojo red #e0262f, blue #3a6bf0 / #7ea0ff,
 * and the site's own logo set (3D torii in a brush ensō with the red 道 seal; Chakra Petch BDOJOX wordmark),
 * copied unchanged from bdojox-site (main 503c880) into scripts/bdojox/. Sizes follow each file's viewBox. Writes webp via sharp:
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

// Card 1: the site's lockup (mark + wordmark) with a belt rule.
const card1 = `${open}${ground}
${place('logo-lockup.svg', W * 0.355, H * 0.44, W * 0.32)}
${beltRule(W * 0.41, H * 0.63, 190, 5)}</svg>`;

// Card 2: the site's mark (ensō, torii, seal), the wordmark beneath.
const card2 = `${open}${ground}
${place('logo.svg', W * 0.51 - 70, H * 0.43 - 70, 140)}
${place('wordmark.svg', W * 0.44, H * 0.62, W * 0.15)}</svg>`;

for (const [name, svg] of [
  ['bdojox-card-1', card1],
  ['bdojox-card-2', card2],
]) {
  const out = new URL(`${name}.webp`, OUT).pathname;
  await sharp(Buffer.from(svg)).webp({ quality: 82, effort: 6 }).toFile(out);
  console.log(out);
}
