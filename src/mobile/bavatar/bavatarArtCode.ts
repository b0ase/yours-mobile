/**
 * bAvatar art code (round 2): the art IS the QR. The full bAvatar blend covers the circle edge to
 * edge; every module is the art at that spot pushed only as far as it must go — a small core forced
 * to the target luminance (deep ink for dark, bright gold for light) and the rest of the cell a light
 * tint over the art, so hue and texture survive. Finders are gold rings (the bAvatar ring motif)
 * over a deep ground, the quiet zone is a narrow band of gold-washed art, and decorative
 * pseudo-modules fill the circle outside the code square so the whole thing reads round.
 *
 * Pure: no DOM, no network, no rasteriser (so core colours come from the palette, not sampled pixels).
 * Encodes bitcoin:<address>, error correction H. Not wired into minting.
 */
import * as qr from 'qrcode';
import { bavatarSvg, seedFrom, bavatarSeed } from './bavatar';
import { bitcoinUri } from './bavatarQr';

export type ArtCodeVariant = 'bold' | 'art' | 'balanced' | 'safe';
export const ART_CODE_VARIANTS: ArtCodeVariant[] = ['bold', 'art', 'balanced', 'safe'];

/** co: core opacity (below 1 the art's strokes show faintly through); qo: quiet-zone wash.
 *  core: share of the cell forced to target luminance. lt/dt: opacity of the whole-cell push towards
 *  light gold / ink (asymmetric: the art is mostly dark, so light modules need the bigger push). */
const TUNE: Record<ArtCodeVariant, { core: number; lt: number; dt: number; quiet: number; co: number; qo: number }> = {
  bold: { core: 0.64, lt: 0.22, dt: 0.88, quiet: 2, co: 0.8, qo: 0.66 },
  art: { core: 0.66, lt: 0.28, dt: 0.9, quiet: 2, co: 0.86, qo: 0.72 },
  balanced: { core: 0.7, lt: 0.36, dt: 0.92, quiet: 2, co: 0.92, qo: 0.78 },
  safe: { core: 0.76, lt: 0.5, dt: 0.95, quiet: 2.5, co: 1, qo: 0.84 },
};

const INK = '#100b04', // L ≈ 4%
  LIGHT = '#ffd96a', // L ≈ 87%
  LIGHT_TINT = '#ffe7a3',
  GOLD = '#e9b52a';

export interface ArtCodeOptions {
  size?: number;
  variant?: ArtCodeVariant;
  circle?: boolean;
  logo?: boolean;
  /** Decorative pseudo-modules outside the code square (default on). */
  fringe?: boolean;
  /** Gold halo ring around each finder (default on). */
  halo?: boolean;
  /** Override the variant's tuning (experiments). */
  tune?: Partial<(typeof TUNE)[ArtCodeVariant]>;
}

const f = (v: number) => String(+v.toFixed(3)).replace(/^0\./, '.').replace(/^-0\./, '-.');

export function bavatarArtCodeSvg(identityKeyOrName: string, address: string, opts: ArtCodeOptions = {}): string {
  const S = opts.size ?? 512,
    v = opts.variant ?? 'balanced',
    t = { ...TUNE[v], ...opts.tune };
  const m = qr.create(bitcoinUri(address), { errorCorrectionLevel: 'H' }).modules;
  const n = m.size,
    side = S / Math.SQRT2, // code + quiet zone inscribed in the circle
    cell = side / (n + 2 * t.quiet),
    off = (S - n * cell) / 2;
  const seed = bavatarSeed(identityKeyOrName),
    id = 'ac' + ((seedFrom('ac:' + seed + v)() * 1e9) >>> 0).toString(36);
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const c = n / 2,
    lr = opts.logo ? 2.2 : 0,
    inLogo = (x: number, y: number) => lr > 0 && Math.hypot(x + 0.5 - c, y + 0.5 - c) < lr + 0.3;

  // Cores: each module's centre (share `core` of the cell) forced to its target luminance, joined to
  // same-colour neighbours so light and dark regions stay contiguous (dark art lines between two
  // light cores were splitting light areas for decoders). Art shows at every dark/light boundary.
  const k = t.core,
    gap = (1 - k) / 2,
    inCode = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && !finder(x, y) && !inLogo(x, y);
  const dark = (x: number, y: number) => inCode(x, y) && !!m.get(y, x),
    light = (x: number, y: number) => inCode(x, y) && !m.get(y, x);
  const rects = (u = 100) => {
    let d = '',
      px = 0,
      py = 0;
    return {
      // Integer 1/u of a module (core paths carry scale(.01); runs are whole modules): exact relative moves, short text.
      add(x: number, y: number, w: number, h: number) {
        const X = Math.round(x * u),
          Y = Math.round(y * u),
          W = Math.round(w * u),
          H = Math.round(h * u);
        d += `${d ? 'm' : 'M'}${X - px} ${Y - py}h${W}v${H}h${-W}z`;
        px = X;
        py = Y;
      },
      get d() {
        return d;
      },
    };
  };
  const joined = (on: (x: number, y: number) => boolean, bridges = true) => {
    const r = rects();
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (on(x, y) && !on(x - 1, y)) {
          let w = 1;
          while (on(x + w, y)) w++;
          r.add(x + gap, y + gap, w - 2 * gap, k);
        }
        const both = (xx: number) => on(xx, y) && on(xx, y + 1);
        if (bridges && both(x) && !both(x - 1)) {
          let w = 1;
          while (both(x + w)) w++;
          r.add(x + gap, y + 1 - gap, w - 2 * gap, 2 * gap);
        }
      }
    return r.d;
  };
  // Whole-cell dark push: merged horizontal runs of dark modules.
  const runR = rects(1);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (dark(x, y) && !dark(x - 1, y)) {
        let w = 1;
        while (dark(x + w, y)) w++;
        runR.add(x, y, w, 1);
      }
  const runs = runR.d,
    cores = joined(dark, false), // the dark cell push already keeps dark regions contiguous
    lightCores = joined(light);

  const art = bavatarSvg(identityKeyOrName, { size: 512 })
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<svg\b[^>]*?>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg x="0" y="0" width="${S}" height="${S}"`);

  const qz = t.quiet,
    N = n + 2 * qz;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<defs><clipPath id="${id}"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}"/></clipPath>`,
    `<path id="${id}r" d="${runs}"/>`,
    `<mask id="${id}m" maskUnits="userSpaceOnUse" x="${-qz}" y="${-qz}" width="${N}" height="${N}"><rect x="${-qz}" y="${-qz}" width="${N}" height="${N}" fill="#fff"/><use href="#${id}r" fill="#000"/></mask>`,
    // Fringe: decorative gold pseudo-modules on the same grid, a 5×5 seeded tile.
    `<pattern id="${id}f" width="5" height="5" patternUnits="userSpaceOnUse">${fringeTile(seed, k)}</pattern></defs>`,
    opts.circle ? `<g clip-path="url(#${id})">` : '<g>',
    `<rect width="${S}" height="${S}" fill="#0b0a08"/>`,
    art,
    `<g transform="translate(${f(off)} ${f(off)}) scale(${f(cell)})">`,
    // Fringe everywhere outside the code square (+ quiet zone).
    opts.fringe === false ? '' : `<path fill="url(#${id}f)" fill-rule="evenodd" d="M${f(-off / cell)} ${f(-off / cell)}h${f(S / cell)}v${f(S / cell)}h${f(-S / cell)}zM${-qz} ${-qz}v${N}h${N}v${-N}z"/>`,
    // Light push over the whole code + quiet zone except dark modules, then dark push on them.
    `<path fill="${LIGHT_TINT}" fill-opacity="${t.qo}" fill-rule="evenodd" d="M${-qz} ${-qz}h${N}v${N}h${-N}zM0 0v${n}h${n}v${-n}z"/>`,
    `<rect width="${n}" height="${n}" fill="${LIGHT_TINT}" fill-opacity="${t.lt}" mask="url(#${id}m)"/>`,
    `<use href="#${id}r" fill="${INK}" fill-opacity="${t.dt}"/>`,
    `<path fill="${LIGHT}" fill-opacity="${t.co}" transform="scale(.01)" d="${lightCores}"/>`,
    `<path fill="${INK}" fill-opacity="${t.co}" transform="scale(.01)" d="${cores}"/>`,
  ];
  // Finders: the 1:1:3:1:1 structure (dark ring, light gap, dark eye) with modest rounding so the
  // diagonal ratios hold too, framed by a gold rounded ring in the light separator (the bAvatar ring
  // motif). Nothing gold crosses the dark bands: that is what stops decoders.
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ])
    out.push(
      `<rect x="${fx - 1}" y="${fy - 1}" width="9" height="9" rx="1.6" fill="${LIGHT_TINT}" fill-opacity=".9"/>`,
      opts.halo === false
        ? ''
        : `<rect x="${fx - 0.55}" y="${fy - 0.55}" width="8.1" height="8.1" rx="1.9" fill="none" stroke="${GOLD}" stroke-width=".28"/>`,
      `<rect x="${fx}" y="${fy}" width="7" height="7" rx="1.5" fill="${INK}"/>`,
      `<rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" rx="1" fill="${LIGHT}"/>`,
      `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx=".7" fill="${INK}"/>`,
    );
  if (lr)
    out.push(
      `<circle cx="${c}" cy="${c}" r="${lr}" fill="${INK}" stroke="${GOLD}" stroke-width=".2"/>`,
      `<text x="${c}" y="${f(c + lr * 0.42)}" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${f(lr * 1.35)}" text-anchor="middle" fill="#ffd24d">b</text>`,
    );
  out.push('</g></g></svg>');
  return out.join('');
}

function fringeTile(seed: string, k: number): string {
  const r = seedFrom('fringe:' + seed);
  let out = '';
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) {
      if (r() > 0.42) continue;
      const s = k * (0.55 + 0.4 * r()),
        i = (1 - s) / 2;
      out += `<rect x="${f(x + i)}" y="${f(y + i)}" width="${f(s)}" height="${f(s)}" rx="${f(s * 0.25)}" fill="${GOLD}" fill-opacity=".8"/>`;
    }
  return out;
}
