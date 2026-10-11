/**
 * bAvatars: a picture drawn from a bWalletX identity, as SVG. Same identity, same picture, in any app.
 *
 * ⚠ ONE MODULE, THREE COPIES. The art is the generator on bwalletx.com/bavatars (bwalletx-site
 * bavatars.js: Kintsugi, Orbit, Sigil, Deco Fan, Bloom, QR). This file ports those canvas drawing
 * routines unchanged onto a tiny SVG-recording context, so the server (bChatX /api/bavatar), the
 * paymail profile and the wallet all produce byte-identical SVG for the same identity key. Copies:
 *   bit-sign  src/lib/bavatar/bavatar.ts      (the source of truth)
 *   bwalletX  src/mobile/bavatar/bavatar.ts   (this copy: keep in step)
 * Pure: no DOM, no network. The QR needs a module matrix, which the caller passes in (qrcode's
 * `create(text, { errorCorrectionLevel: 'H' }).modules`), so this file has no dependencies.
 *
 * Default avatar (owner, 11 Oct 2026): every account without its own picture gets a blend of 3–4
 * styles chosen from a hash of its identity key: Bloom light underneath, then two or three of
 * Orbit, Deco Fan, Kintsugi and a Sigil seal. The art-QR variant carries name@bwalletx.com.
 */

// ── Seeded randomness (cyrb128 → sfc32), identical to bavatars.js ──────────────────────────────
export function seedFrom(str: string): () => number {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  let a = (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    b = (h2 ^ h1) >>> 0,
    c = (h3 ^ h1) >>> 0,
    d = (h4 ^ h1) >>> 0;
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];
const GOLD = ['#e9b52a', '#f2c230', '#ffd24d', '#d9a21a', '#c58b12', '#f6dc8a'];

// ── A canvas-like context that records SVG ───────────────────────────────────────────────────────
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
/** '#rrggbbaa' → rgba(), so every SVG renderer reads it. */
function color(c: string): string {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c);
  if (!m) return c;
  const v = parseInt(m[1], 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${n2(parseInt(m[2], 16) / 255)})`;
}
interface Grad {
  id: string;
  addColorStop(o: number, c: string): void;
}
interface State {
  fillStyle: string | Grad;
  strokeStyle: string | Grad;
  lineWidth: number;
  lineCap: string;
  globalAlpha: number;
  shadowBlur: number;
  shadowColor: string;
  composite: string;
  tx: number;
  ty: number;
  clip: string | null;
}
export class SvgCtx {
  private defs: string[] = [];
  private body: string[] = [];
  private d = '';
  private cur: [number, number] | null = null;
  private ids = 0;
  private filters = new Map<string, string>();
  private st: State = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: 'transparent',
    composite: 'source-over',
    tx: 0,
    ty: 0,
    clip: null,
  };
  private stack: State[] = [];
  constructor(private readonly prefix: string) {}
  get fillStyle() {
    return this.st.fillStyle as string;
  }
  set fillStyle(v: string | Grad) {
    this.st.fillStyle = v;
  }
  get strokeStyle() {
    return this.st.strokeStyle as string;
  }
  set strokeStyle(v: string | Grad) {
    this.st.strokeStyle = v;
  }
  get lineWidth() {
    return this.st.lineWidth;
  }
  set lineWidth(v: number) {
    this.st.lineWidth = v;
  }
  get lineCap() {
    return this.st.lineCap;
  }
  set lineCap(v: string) {
    this.st.lineCap = v;
  }
  get globalAlpha() {
    return this.st.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.st.globalAlpha = v;
  }
  get shadowBlur() {
    return this.st.shadowBlur;
  }
  set shadowBlur(v: number) {
    this.st.shadowBlur = v;
  }
  get shadowColor() {
    return this.st.shadowColor;
  }
  set shadowColor(v: string) {
    this.st.shadowColor = v;
  }
  get globalCompositeOperation() {
    return this.st.composite;
  }
  set globalCompositeOperation(v: string) {
    this.st.composite = v;
  }
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';

  private id(kind: string) {
    return `${this.prefix}${kind}${this.ids++}`;
  }
  save() {
    this.stack.push({ ...this.st });
  }
  restore() {
    const s = this.stack.pop();
    if (s) this.st = s;
  }
  translate(x: number, y: number) {
    this.st.tx += x;
    this.st.ty += y;
  }
  clearRect() {
    /* every avatar starts on a fresh context */
  }
  beginPath() {
    this.d = '';
    this.cur = null;
  }
  moveTo(x: number, y: number) {
    this.d += `M${n2(x)} ${n2(y)}`;
    this.cur = [x, y];
  }
  lineTo(x: number, y: number) {
    if (!this.cur) return this.moveTo(x, y);
    this.d += `L${n2(x)} ${n2(y)}`;
    this.cur = [x, y];
  }
  closePath() {
    this.d += 'Z';
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false) {
    const TAU = Math.PI * 2;
    const sx = cx + Math.cos(a0) * r,
      sy = cy + Math.sin(a0) * r;
    if (this.cur) this.lineTo(sx, sy);
    else this.moveTo(sx, sy);
    let delta = a1 - a0;
    const full = ccw ? delta <= -TAU : delta >= TAU;
    if (full || (delta !== 0 && Math.abs(delta) % TAU === 0)) {
      const mx = cx - Math.cos(a0) * r,
        my = cy - Math.sin(a0) * r,
        sw = ccw ? 0 : 1;
      this.d += `A${n2(r)} ${n2(r)} 0 1 ${sw} ${n2(mx)} ${n2(my)}A${n2(r)} ${n2(r)} 0 1 ${sw} ${n2(sx)} ${n2(sy)}`;
      this.cur = [sx, sy];
      return;
    }
    delta = ccw ? -((((a0 - a1) % TAU) + TAU) % TAU) : ((delta % TAU) + TAU) % TAU;
    const ex = cx + Math.cos(a0 + delta) * r,
      ey = cy + Math.sin(a0 + delta) * r;
    this.d += `A${n2(r)} ${n2(r)} 0 ${Math.abs(delta) > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${n2(ex)} ${n2(ey)}`;
    this.cur = [ex, ey];
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number) {
    if (!this.cur) this.moveTo(x1, y1);
    const [x0, y0] = this.cur!;
    let ux = x0 - x1,
      uy = y0 - y1,
      vx = x2 - x1,
      vy = y2 - y1;
    const lu = Math.hypot(ux, uy),
      lv = Math.hypot(vx, vy);
    if (!lu || !lv || !r) return this.lineTo(x1, y1);
    ux /= lu;
    uy /= lu;
    vx /= lv;
    vy /= lv;
    const cross = ux * vy - uy * vx,
      angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (Math.abs(cross) < 1e-9) return this.lineTo(x1, y1);
    const t = r / Math.tan(angle / 2);
    this.lineTo(x1 + ux * t, y1 + uy * t);
    const ex = x1 + vx * t,
      ey = y1 + vy * t;
    this.d += `A${n2(r)} ${n2(r)} 0 0 ${cross < 0 ? 1 : 0} ${n2(ex)} ${n2(ey)}`;
    this.cur = [ex, ey];
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): Grad {
    const id = this.id('g'),
      stops: string[] = [];
    const g = {
      id,
      addColorStop: (o: number, c: string) => {
        stops.push(`<stop offset="${n2(o)}" stop-color="${color(c)}"/>`);
      },
    };
    // Stops arrive after creation, so the def is written lazily by reference.
    this.defs.push('');
    const at = this.defs.length - 1;
    Object.defineProperty(g, 'toDef', {
      value: () =>
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n2(x1)}" cy="${n2(y1)}" r="${n2(r1)}" fx="${n2(x0)}" fy="${n2(y0)}" fr="${n2(r0)}">${stops.join('')}</radialGradient>`,
    });
    this.lazy.push([at, g as Grad & { toDef(): string }]);
    return g;
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): Grad {
    const id = this.id('g'),
      stops: string[] = [];
    const g = {
      id,
      addColorStop: (o: number, c: string) => {
        stops.push(`<stop offset="${n2(o)}" stop-color="${color(c)}"/>`);
      },
    };
    this.defs.push('');
    const at = this.defs.length - 1;
    Object.defineProperty(g, 'toDef', {
      value: () =>
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n2(x0)}" y1="${n2(y0)}" x2="${n2(x1)}" y2="${n2(y1)}">${stops.join('')}</linearGradient>`,
    });
    this.lazy.push([at, g as Grad & { toDef(): string }]);
    return g;
  }
  private lazy: [number, Grad & { toDef(): string }][] = [];
  private paint(p: string | Grad) {
    return typeof p === 'string' ? color(p) : `url(#${p.id})`;
  }
  private common() {
    const s = this.st,
      a: string[] = [];
    if (s.tx || s.ty) a.push(`transform="translate(${n2(s.tx)} ${n2(s.ty)})"`);
    if (s.globalAlpha !== 1) a.push(`opacity="${n2(s.globalAlpha)}"`);
    if (s.composite === 'lighter') a.push('style="mix-blend-mode:screen"');
    return a.join(' ');
  }
  /** A clip lives in the page's space, so it wraps the (possibly translated) shape in a group. */
  private emit(el: string) {
    this.body.push(this.st.clip ? `<g clip-path="url(#${this.st.clip})">${el}</g>` : el);
  }
  private blur(sd: number) {
    const key = n2(sd);
    let id = this.filters.get(key);
    if (!id) {
      id = this.id('f');
      this.filters.set(key, id);
      this.defs.push(
        `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${key}"/></filter>`,
      );
    }
    return id;
  }
  fill() {
    if (this.d) this.emit(`<path d="${this.d}" fill="${this.paint(this.st.fillStyle)}" ${this.common()}/>`);
  }
  stroke() {
    if (!this.d) return;
    const s = this.st,
      base = `fill="none" stroke-width="${n2(s.lineWidth)}" stroke-linecap="${s.lineCap}" stroke-linejoin="round"`;
    if (s.shadowBlur > 0 && s.shadowColor !== 'transparent') {
      this.emit(
        `<path d="${this.d}" ${base} stroke="${color(s.shadowColor)}" filter="url(#${this.blur(s.shadowBlur / 2)})" ${this.common()}/>`,
      );
    }
    this.emit(`<path d="${this.d}" ${base} stroke="${this.paint(s.strokeStyle)}" ${this.common()}/>`);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.emit(
      `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${this.paint(this.st.fillStyle)}" ${this.common()}/>`,
    );
  }
  clip() {
    const id = this.id('c'),
      s = this.st;
    const t = s.tx || s.ty ? ` transform="translate(${n2(s.tx)} ${n2(s.ty)})"` : '';
    this.defs.push(`<clipPath id="${id}"><path d="${this.d}"${t}/></clipPath>`);
    s.clip = id;
  }
  fillText(text: string, x: number, y: number) {
    const size = /(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '16';
    const esc = text.replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.emit(
      `<text x="${n2(x)}" y="${n2(y)}" font-size="${size}" font-weight="800" font-family="Georgia, serif" text-anchor="middle" dominant-baseline="middle" fill="${this.paint(this.st.fillStyle)}" ${this.common()}>${esc}</text>`,
    );
  }
  toSvg(size: number, label: string) {
    for (const [at, g] of this.lazy) this.defs[at] = g.toDef();
    const esc = label.replace(/[<&>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc}"><defs>${this.defs.join('')}</defs>${this.body.join('')}</svg>`;
  }
}
type Ctx = SvgCtx;

// ── The drawing routines, as in bavatars.js ─────────────────────────────────────────────────────
function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawBloom(ctx: Ctx, S: number, r: () => number) {
  ctx.fillStyle = '#0b0a08';
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    const x = S * (0.2 + r() * 0.6),
      y = S * (0.2 + r() * 0.6),
      R = S * (0.18 + r() * 0.3),
      g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, pick(r, GOLD) + 'cc');
    g.addColorStop(1, '#00000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  ctx.globalCompositeOperation = 'source-over';
}
function drawOrbit(ctx: Ctx, S: number, r: () => number) {
  const n = 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const rad = S * (0.12 + i * 0.075),
      start = r() * Math.PI * 2,
      len = Math.PI * (0.6 + r() * 1.3);
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, rad, start, start + len);
    ctx.strokeStyle = i % 2 ? '#f2c230' : '#c58b12';
    ctx.lineWidth = S * 0.035;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.06, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd24d';
  ctx.fill();
}
function drawFans(ctx: Ctx, S: number, r: () => number) {
  const fans = 2 + Math.floor(r() * 2),
    base = S * (1.03 + r() * 0.06);
  for (let f = 0; f < fans; f++) {
    const cx = S * (0.25 + f * (0.5 / Math.max(1, fans - 1))),
      rays = 7 + Math.floor(r() * 6),
      R = S * (0.52 + r() * 0.25);
    for (let i = 0; i <= rays; i++) {
      const a = Math.PI + (Math.PI * i) / rays;
      ctx.beginPath();
      ctx.moveTo(cx, base);
      ctx.lineTo(cx + Math.cos(a) * R, base + Math.sin(a) * R);
      ctx.strokeStyle = '#f6dc8a';
      ctx.lineWidth = S * 0.006;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, base, R, Math.PI, 0);
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = S * 0.014;
    ctx.stroke();
  }
}
function drawCracks(ctx: Ctx, S: number, r: () => number) {
  ctx.lineCap = 'round';
  const cracks = 2 + Math.floor(r() * 3);
  for (let c = 0; c < cracks; c++) {
    let x = r() * S,
      y = r() < 0.5 ? 0 : S,
      ang = Math.atan2(S / 2 - y, S / 2 - x) + (r() - 0.5);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let i = 0; i < 9; i++) {
      ang += (r() - 0.5) * 1.1;
      x += Math.cos(ang) * S * 0.12;
      y += Math.sin(ang) * S * 0.12;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffe08a';
    ctx.lineWidth = S * (0.01 + r() * 0.014);
    ctx.shadowColor = '#f2c230aa';
    ctx.shadowBlur = S * 0.025;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}
/** The Sigil as a seal: the mirrored 5×5 pattern on a gold coin in the middle. */
function drawSeal(ctx: Ctx, S: number, r: () => number) {
  const R = S * 0.2;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, R, 0, Math.PI * 2);
  ctx.fillStyle = '#e9b52a';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#0b0a08';
  ctx.lineWidth = S * 0.012;
  ctx.stroke();
  const cells = 5,
    c = (R * 1.2) / cells,
    x0 = S / 2 - (c * cells) / 2,
    y0 = S / 2 - (c * cells) / 2;
  ctx.fillStyle = '#0b0a08';
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < 3; x++)
      if (r() > 0.5) {
        ctx.fillRect(x0 + x * c, y0 + y * c, c + 0.5, c + 0.5);
        ctx.fillRect(x0 + (cells - 1 - x) * c, y0 + y * c, c + 0.5, c + 0.5);
      }
}

export type BlendLayer = 'orbit' | 'deco' | 'kintsugi' | 'sigil';
const LAYERS: Record<BlendLayer, (ctx: Ctx, S: number, r: () => number) => void> = {
  orbit: drawOrbit,
  deco: drawFans,
  kintsugi: drawCracks,
  sigil: drawSeal,
};
const ORDER: BlendLayer[] = ['deco', 'orbit', 'kintsugi', 'sigil'];

/** The 3–4 styles an identity's bAvatar blends: Bloom always, plus two or three layers. */
export function blendFor(seed: string): { styles: string[]; layers: BlendLayer[] } {
  const r = seedFrom('blend:' + seed);
  const pool = [...ORDER];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, 2 + Math.floor(r() * 2));
  const layers = ORDER.filter((l) => chosen.includes(l)); // painted back to front
  return { styles: ['bloom', ...layers], layers };
}

/** Normalise the seed: a 33-byte compressed public key (hex) or, failing that, a name. */
export function bavatarSeed(identityKeyOrName: string): string {
  const v = String(identityKeyOrName).trim().toLowerCase();
  return /^0[23][0-9a-f]{64}$/.test(v) ? v : 'name:' + cleanName(v);
}
export const cleanName = (v: string) =>
  String(v)
    .toLowerCase()
    .replace(/^[$@]/, '')
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40) || 'b';

function paintBlend(ctx: Ctx, S: number, seed: string, x0 = 0, y0 = 0) {
  ctx.save();
  ctx.translate(x0, y0);
  drawBloom(ctx, S, seedFrom('bloom:' + seed));
  for (const l of blendFor(seed).layers) {
    if (l === 'deco') ctx.globalAlpha = 0.85;
    LAYERS[l](ctx, S, seedFrom(l + ':' + seed));
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** The everyday bAvatar: the blend, as an SVG string. `seed` from bavatarSeed(). */
export function bavatarSvg(identityKeyOrName: string, opts: { size?: number; label?: string } = {}): string {
  const S = opts.size ?? 512,
    seed = bavatarSeed(identityKeyOrName);
  const ctx = new SvgCtx('ba' + ((seedFrom('id:' + seed)() * 1e9) >>> 0).toString(36) + '_');
  paintBlend(ctx, S, seed);
  return ctx.toSvg(S, opts.label ?? 'bAvatar');
}

/** Art lift towards pale gold, and module dot size: as on bwalletx.com/bavatars (zbar reads it, see selftest). */
const ART_LIFT = 0.18,
  DOT = 0.62;

/** A QR module matrix (qrcode's `create(text, { errorCorrectionLevel: 'H' }).modules`). */
export interface QrMatrix {
  size: number;
  get(row: number, col: number): number | boolean;
}

/**
 * The art QR: the blend seen through a standard QR (dark dots on pale gold, solid finder squares),
 * scannable by any phone camera. Encodes `paymail` (name@bwalletx.com); build `qr` with error
 * correction H from exactly that text.
 */
export function bavatarArtQrSvg(
  identityKeyOrName: string,
  paymail: string,
  qr: QrMatrix,
  /** `dot` (share of a cell) and `lift` (pale wash over the art) default to the bit-sign values; the
   *  wallet card raises both so every common decoder reads it, not only phone cameras. */
  opts: { size?: number; dot?: number; lift?: number; pip?: boolean } = {},
): string {
  const S = opts.size ?? 512,
    seed = bavatarSeed(identityKeyOrName);
  const ctx = new SvgCtx('bq' + ((seedFrom('id:' + seed)() * 1e9) >>> 0).toString(36) + '_');
  const n = qr.size,
    quiet = 3,
    cell = S / (n + quiet * 2),
    off = quiet * cell;
  ctx.fillStyle = '#fff3cf';
  ctx.fillRect(0, 0, S, S);
  // The art stays inside the code area, and is lifted towards pale gold so the light
  // modules read light to a camera; the dark modules carry the code.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(off, off);
  ctx.lineTo(off + n * cell, off);
  ctx.lineTo(off + n * cell, off + n * cell);
  ctx.lineTo(off, off + n * cell);
  ctx.closePath();
  ctx.clip();
  paintBlend(ctx, n * cell, seed, off, off);
  ctx.fillStyle = 'rgba(255,243,207,' + (opts.lift ?? ART_LIFT) + ')';
  ctx.fillRect(off, off, n * cell, n * cell);
  ctx.restore();
  const finder = (x: number, y: number) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  const dot = cell * (opts.dot ?? DOT),
    inset = (cell - dot) / 2;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (finder(x, y)) continue;
      ctx.fillStyle = qr.get(y, x) ? '#0b0a08' : '#fff3cf';
      roundRect(ctx, off + x * cell + inset, off + y * cell + inset, dot, dot, dot * 0.3);
      ctx.fill();
    }
  // Finder squares stay solid (a gold ring inside the centre stopped decoders); one small gold pip.
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    const x = off + fx * cell,
      y = off + fy * cell;
    ctx.fillStyle = '#fff3cf';
    ctx.fillRect(x - cell, y - cell, cell * 9, cell * 9);
    ctx.fillStyle = '#0b0a08';
    roundRect(ctx, x, y, cell * 7, cell * 7, cell * 1.6);
    ctx.fill();
    ctx.fillStyle = '#fff3cf';
    roundRect(ctx, x + cell, y + cell, cell * 5, cell * 5, cell * 1.1);
    ctx.fill();
    ctx.fillStyle = '#0b0a08';
    roundRect(ctx, x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell * 0.8);
    ctx.fill();
    // The gold pip stops ZXing (Android's usual decoder) finding the square; the card turns it off.
    if (opts.pip !== false) {
      ctx.fillStyle = '#d9a21a';
      roundRect(ctx, x + cell * 3.1, y + cell * 3.1, cell * 0.8, cell * 0.8, cell * 0.4);
      ctx.fill();
    }
  }
  return ctx.toSvg(S, paymail);
}
