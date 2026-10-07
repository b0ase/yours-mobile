import { Hash, Utils } from '@bsv/sdk';
import { getStroke } from 'perfect-freehand';

/**
 * Hand-drawn signature (shown on the back of the wallet card, and later used to sign bit-sign
 * .NDS.HTML contracts, where the identity key seals it on-chain).
 *
 * Stable API for that integration: getSignature(accountId) → { svgPath, viewBox, createdAt, sha256 },
 * sha256 taken over canonicalSvg(svgPath): deterministic bytes, so the hash can be signed.
 * NOT exposed to bApps/websites: bit-sign will add a consent prompt first.
 * Stored only on this device, per account
 * (keyed by identity address, like names/myName.ts). Never sent anywhere or put on-chain.
 *
 * Format: one SVG path string (filled outlines from perfect-freehand) in a 0..1000 × 0..250 viewBox,
 * integer coordinates, at most SIG_MAX_BYTES.
 */
export const SIG_W = 1000;
export const SIG_H = 250;
export const SIG_MAX_BYTES = 8 * 1024;

/** [x, y, pressure] in pad pixels. */
export type SigPoint = [number, number, number];
export type SigStroke = { points: SigPoint[]; pen: boolean };

const STROKE_OPTS = { size: 14, thinning: 0.6, smoothing: 0.5, streamline: 0.5 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pad pixels → the 1000 × 250 box, clamped. */
export const normalisePoints = (pts: SigPoint[], w: number, h: number): SigPoint[] =>
  w > 0 && h > 0
    ? pts.map(([x, y, p]) => [clamp((x * SIG_W) / w, 0, SIG_W), clamp((y * SIG_H) / h, 0, SIG_H), p])
    : [];

/** Ramer–Douglas–Peucker on x/y; keeps first and last points. */
export const simplifyPoints = (pts: SigPoint[], tolerance: number): SigPoint[] => {
  if (pts.length < 3 || tolerance <= 0) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let max = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max > tolerance && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
};

/** Outline polygon → "Mx yLx y…Z", integer coordinates clamped to the box. */
export const polygonToPath = (outline: number[][]): string => {
  if (outline.length < 2) return '';
  const pt = ([x, y]: number[]) => `${Math.round(clamp(x, 0, SIG_W))} ${Math.round(clamp(y, 0, SIG_H))}`;
  const [first, ...rest] = outline;
  return `M${pt(first)}` + rest.map((p) => `L${pt(p)}`).join('') + 'Z';
};

/** Outline of one already-normalised stroke. Dots (one point) still draw. */
export const strokeOutline = (stroke: SigStroke): number[][] =>
  stroke.points.length
    ? getStroke(stroke.points, { ...STROKE_OPTS, simulatePressure: !stroke.pen, last: true })
    : [];

/** Normalised strokes → one path string, with no size cap. */
export const strokesToPath = (strokes: SigStroke[], outlineTol = 0.6): string =>
  strokes.map((s) => polygonToPath(simplifyPoints(strokeOutline(s) as SigPoint[], outlineTol))).join('');

/**
 * Pad strokes (pixels) → stored path. Simplifies harder until it fits SIG_MAX_BYTES; returns ''
 * for an empty drawing or one that cannot be made to fit.
 */
export const signatureFromStrokes = (strokes: SigStroke[], w: number, h: number): string => {
  const norm = strokes
    .map((s) => ({ pen: s.pen, points: normalisePoints(s.points, w, h) }))
    .filter((s) => s.points.length > 0);
  if (!norm.length) return '';
  for (const tol of [0, 1, 2, 3, 5, 8, 12, 20, 30, 45]) {
    const pts = norm.map((s) => ({ pen: s.pen, points: simplifyPoints(s.points, tol) }));
    const path = strokesToPath(pts, Math.max(0.6, tol / 3));
    if (path.length <= SIG_MAX_BYTES) return path;
  }
  return '';
};

/** Only what signatureFromStrokes produces: M/L/Z with integers inside the box. */
const PATH_RE = /^(M\d{1,4} \d{1,3}(L\d{1,4} \d{1,3})*Z)+$/;
export const isValidSignature = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= SIG_MAX_BYTES && PATH_RE.test(s);

export const SIG_VIEWBOX = `0 0 ${SIG_W} ${SIG_H}`;

/** The exact bytes that are hashed (and later signed). Never change this format without a version bump. */
export const canonicalSvg = (svgPath: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SIG_VIEWBOX}"><path d="${svgPath}"/></svg>`;

export const signatureSha256 = (svgPath: string): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(canonicalSvg(svgPath), 'utf8')));

export type Signature = { svgPath: string; viewBox: string; createdAt: number; sha256: string };
type Stored = { v: 1; svgPath: string; createdAt: number };

const key = (accountId: string) => `bwallet.signature.${accountId}`;
const EVENT = 'bwallet-signature-changed';

const parse = (raw: string | null): Stored | null => {
  if (!raw || raw.length > SIG_MAX_BYTES + 200) return null;
  try {
    const o = JSON.parse(raw) as Partial<Stored>;
    if (o?.v !== 1 || !isValidSignature(o.svgPath)) return null;
    if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt) || o.createdAt < 0) return null;
    return { v: 1, svgPath: o.svgPath, createdAt: o.createdAt };
  } catch {
    return null;
  }
};

/** This account's signature (accountId = identity address), or null. Corrupt data reads as null. */
export const getSignature = (accountId?: string): Signature | null => {
  if (!accountId) return null;
  let s: Stored | null = null;
  try {
    s = parse(localStorage.getItem(key(accountId)));
  } catch {
    return null;
  }
  return s && { svgPath: s.svgPath, viewBox: SIG_VIEWBOX, createdAt: s.createdAt, sha256: signatureSha256(s.svgPath) };
};

/** '' (or anything invalid) removes it. */
export const setSignature = (accountId: string, svgPath: string, now = Date.now()) => {
  try {
    if (isValidSignature(svgPath)) {
      const stored: Stored = { v: 1, svgPath, createdAt: now };
      localStorage.setItem(key(accountId), JSON.stringify(stored));
    } else localStorage.removeItem(key(accountId));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
};

export const onSignatureChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Screen box of the pad (getBoundingClientRect). */
export type PadRect = { left: number; top: number; width: number; height: number };

/**
 * Portrait phones draw the pad rotated 90° clockwise (CSS rotate(90deg)) so it runs along the long
 * side. The pad's own x axis then points down the screen and its y axis points left. These map
 * between screen (client) coordinates and the pad's unrotated local pixels, whose size is padSize().
 */
export const padSize = (r: PadRect, rotated: boolean) =>
  rotated ? { w: r.height, h: r.width } : { w: r.width, h: r.height };

export const screenToPad = (cx: number, cy: number, r: PadRect, rotated: boolean): [number, number] =>
  rotated ? [cy - r.top, r.left + r.width - cx] : [cx - r.left, cy - r.top];

export const padToScreen = (x: number, y: number, r: PadRect, rotated: boolean): [number, number] =>
  rotated ? [r.left + r.width - y, r.top + x] : [r.left + x, r.top + y];
