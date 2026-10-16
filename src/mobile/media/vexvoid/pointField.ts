/**
 * The VexVoid point field, ported from the hero of b0ase.github.io/vexvoid-AV-client (vx-engine.js, "point
 * fields after @yuruyurau"). Pure 2D canvas, no library: white 1px points on a fading black field, a formula
 * cross-fade every few seconds, rare glitch shears and a light grain. The AV client's video clips, mercury
 * shader and decals are left out to keep this small and fast on an iPhone 11.
 */
export type Formula = { n: number; dv: number; mirror?: boolean; f: (x: number, y: number) => [number, number] };

const { sin: Sn, cos: Cs, atan2: At, sqrt: Q, abs: ab } = Math;
const mag = (x: number, y: number) => Q(x * x + y * y);

export interface FieldRenderer {
  resize: (cssW: number, cssH: number) => void;
  /** Draws one frame; dt in 60fps frames. */
  frame: (dt: number) => void;
  /** One still frame for reduced motion. */
  still: () => void;
}

/** Live inputs the formulas read: time and the four slow LFOs. */
export interface FieldEnv {
  t: number;
  m1: number;
  m2: number;
  m3: number;
  m4: number;
}

/** The five point-field formulas, reading time and LFOs from `fe` (shared by the live hero and the still card art). */
export function fieldFormulas(fe: FieldEnv): Formula[] {
  return [
    {
      n: 15000,
      dv: 120,
      f: (x, y) => {
        const k = (4 + Sn(y * 2 * fe.m4 - fe.t) * 3) * Cs(x / (29 * fe.m1));
        const e = y / 8 - 13;
        const d = mag(k, e);
        const q = 3 * Sn(k * 2 * fe.m2) + 0.3 / k + Sn(y / 25) * k * (9 + 4 * Sn(e * 9 * fe.m3 - d * 3 + fe.t * 2));
        const c = d - fe.t;
        return [q + 30 * Cs(c), q * Sn(c) + d * 39 * fe.m4 - 220];
      },
    },
    {
      n: 12000,
      dv: 35,
      f: (x, y) => {
        const k = 9 * Cs(x / (8 * fe.m1));
        const e = y / 8 - 12.5;
        const d = (mag(k, e) * mag(k, e)) / 99 + Sn(fe.t) / 6 + 0.5;
        const q = 99 - (e * Sn(At(k, e) * ((7 * fe.m2) | 0 || 7))) / d + k * (3 + Cs(d * d * fe.m3 - fe.t) * 2);
        const c = d / 2 + e / 69 - fe.t / 16;
        return [q * Sn(c), (q + 19 * d) * Cs(c)];
      },
    },
    {
      n: 22000,
      dv: 200,
      mirror: true,
      f: (x, y) => {
        const k = x / 12 - 12.5;
        const d = 2 * ab(Cs(k / (2 * fe.m1)) + Sn((y / 4) * fe.m3) + Cs(k / 8));
        const q = x / 4 + 90 + d * k * Cs(d - fe.t * 2 + y / 24);
        const c = y / 79 - fe.t / 8 + (d / 8) * fe.m2;
        return [q * 0.7 * Cs(c) + (q / 8) * Sn(c * 4 * fe.m4), q * 0.7 * Sn(c)];
      },
    },
    {
      n: 18000,
      dv: 60,
      f: (x, y) => {
        const k = 5 * Cs(x / (14 * fe.m1)) * (1 + Sn(y / 9 - fe.t));
        const e = y / 6 - 25;
        const d = mag(k, e) / 4;
        const q = 70 + k * 6 * Sn(d * fe.m2 - fe.t * 1.5) + e * Cs(At(k, e) * 5 * fe.m3);
        const c = d / 3 - fe.t / 10 + (x / 300) * 6.283;
        return [q * Cs(c) * fe.m4, q * Sn(c) * 0.8];
      },
    },
    {
      n: 14000,
      dv: 100,
      f: (x, y) => {
        const u = (x / 300) * 6.283;
        const v = y / 140;
        const r = 120 + 60 * Sn(u * 3 * fe.m2 + fe.t) * Cs(v * 6.283 * fe.m3 - fe.t * 0.7);
        const sh = 40 * Sn(v * 20 + fe.t * 3) * (Sn(fe.t * 0.3) > 0.6 ? 1 : 0.1);
        return [r * Cs(u + v * fe.m1) + sh, (v - 0.5) * 360 * fe.m4 + 30 * Sn(u * 5 - fe.t)];
      },
    },
  ];
}

export function createPointField(cv: HTMLCanvasElement): FieldRenderer | null {
  const g = cv.getContext('2d', { alpha: false });
  if (!g) return null;
  let W = 2;
  let H = 2;
  let cx = 1;
  let cy = 1;
  let sc = 1;
  let cur = 0;
  let nxt = 1;
  let tr = 0;
  const env: FieldEnv = { t: 0, m1: 1, m2: 1, m3: 1, m4: 1 };
  const lfo = () => {
    const t = env.t;
    env.m1 = 1 + 0.35 * Sn(t * 0.071);
    env.m2 = 1 + 0.25 * Sn(t * 0.113 + 1);
    env.m3 = 1 + 0.5 * Sn(t * 0.047 + 2) * Sn(t * 0.19);
    env.m4 = 1 + 0.2 * Cs(t * 0.089 + 3);
  };
  const anims = fieldFormulas(env);
  const baseN = anims.map((a) => a.n);
  // Point budget scales with the area; a phone header is ~6% of the AV client's 1440×900, so ~25% of its points.
  const resize = (cssW: number, cssH: number) => {
    const d = Math.min(window.devicePixelRatio || 1, 1.5);
    W = cv.width = Math.max(2, (cssW * d) | 0);
    H = cv.height = Math.max(2, (cssH * d) | 0);
    cx = W * 0.5;
    cy = H * 0.5;
    sc = Math.min(W, H) / 520;
    const budget = Math.min(1, Math.max(0.22, (cssW * cssH) / (1440 * 900)));
    anims.forEach((a, i) => (a.n = Math.round(baseN[i] * budget)));
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
  };
  const drawOne = (a: Formula, alpha: number) => {
    if (alpha <= 0.01) return;
    g.fillStyle = `rgba(255,255,255,${(0.5 * alpha).toFixed(3)})`;
    // Spread the sample over the formula's full 300 × (n/dv) grid so fewer points keep the whole shape.
    const step = baseN[anims.indexOf(a)] / a.n;
    for (let j = a.n; j--; ) {
      const i = (j * step) | 0;
      const p = a.f(i % 300, (i / a.dv) | 0);
      if (p[0] !== p[0] || p[1] !== p[1]) continue;
      const x = cx + p[0] * sc;
      const y = cy + p[1] * sc;
      g.fillRect(x, y, 1, 1);
      if (a.mirror) g.fillRect(2 * cx - x, y, 1, 1);
    }
  };
  const shear = () => {
    if (Math.random() > 0.05) return;
    const bh = (2 + Math.random() * 14) | 0;
    const by = (Math.random() * (H - bh)) | 0;
    g.drawImage(cv, 0, by, W, bh, ((Math.random() - 0.5) * 40) | 0, by, W, bh);
  };
  const grain = () => {
    const n = (W * H) / 9000;
    for (let i = 0; i < n; i++) {
      const a = Math.random();
      g.fillStyle = `rgba(255,255,255,${(0.08 + a * a * 0.35).toFixed(2)})`;
      g.fillRect((Math.random() * W) | 0, (Math.random() * H) | 0, 1, 1 + ((Math.random() * 3) | 0));
    }
  };
  const frame = (dt: number) => {
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fillRect(0, 0, W, H);
    env.t += (Math.PI / 240) * dt;
    tr += 0.004 * dt;
    lfo();
    if (tr >= 1) {
      tr = 0;
      cur = nxt;
      nxt = (Math.random() * anims.length) | 0;
      if (nxt === cur) nxt = (cur + 1) % anims.length;
    }
    drawOne(anims[cur], 1 - tr);
    drawOne(anims[nxt], tr);
    shear();
    grain();
  };
  const still = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    env.t = 2;
    lfo();
    drawOne(anims[0], 1);
  };
  return { resize, frame, still };
}
