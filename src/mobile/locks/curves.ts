/**
 * Unlock curves: how a gradual schedule spreads its total across the payout dates.
 *
 * A curve gives one weight per payout date. The total (sats, or dollar cents in dollar-target mode) is
 * split in proportion, rounded down, with the rounding remainder on the last piece so the sum is exact.
 * A weight of 0 means no lock output on that date (cliff, step). Pure, no network.
 */

export type CurveKind = 'linear' | 'front' | 'back' | 's-curve' | 'cliff' | 'step' | 'custom';
export type Curve = {
  kind: CurveKind;
  /** front / back: first-to-last ratio (×2 = the biggest payout is twice the smallest). s-curve: sharpness. */
  steepness?: number;
  /** cliff: payouts with nothing before the cliff; what they would have paid is paid at the cliff. */
  cliff?: number;
  /** step: one payout every K periods, each worth K periods. */
  every?: number;
  /** custom: a percentage per payout date, summing to 100. */
  pcts?: number[];
};

export const CURVE_NAMES: Record<CurveKind, string> = {
  linear: 'Linear',
  front: 'Front-loaded',
  back: 'Back-loaded',
  's-curve': 'S-curve',
  cliff: 'Cliff + linear',
  step: 'Step',
  custom: 'Custom',
};
export const DEFAULT_STEEPNESS = 2;
export const DEFAULT_S_STEEPNESS = 8;
export const MAX_STEEPNESS = 100;

const num = (n: number) => Number(n.toFixed(2)).toString();

/** "back-loaded ×2", "cliff 3 + linear", "step every 4", "custom (12 payouts)". */
export function curveLabel(c: Curve | undefined): string {
  if (!c || c.kind === 'linear') return 'linear';
  switch (c.kind) {
    case 'front':
      return `front-loaded ×${num(c.steepness ?? DEFAULT_STEEPNESS)}`;
    case 'back':
      return `back-loaded ×${num(c.steepness ?? DEFAULT_STEEPNESS)}`;
    case 's-curve':
      return `S-curve (${num(c.steepness ?? DEFAULT_S_STEEPNESS)})`;
    case 'cliff':
      return `cliff ${c.cliff ?? 0} + linear`;
    case 'step':
      return `step every ${c.every ?? 1}`;
    case 'custom':
      return `custom (${c.pcts?.length ?? 0} payouts)`;
  }
}

/** Parse "10, 20, 30, 40" (or spaces / new lines) into numbers; null if any part is not a number. */
export function parsePcts(s: string): number[] | null {
  const parts = s.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) return null;
  const out = parts.map((p) => Number(p.replace(/%$/, '')));
  return out.every((x) => Number.isFinite(x)) ? out : null;
}

/** Custom percentages: one per payout, none negative, summing to 100 (to 0.01). An error message, or null. */
export function validateCustom(pcts: number[] | undefined, n: number): string | null {
  if (!pcts || !pcts.length) return 'Enter a percentage for each payout.';
  if (pcts.length !== n) return `Enter ${n} percentages (one per payout); you entered ${pcts.length}.`;
  if (pcts.some((p) => !Number.isFinite(p) || p < 0)) return 'Percentages cannot be negative.';
  const sum = pcts.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) return `The percentages add up to ${num(sum)}%, not 100%.`;
  return null;
}

/** One weight per payout (not normalised), or an error message. */
export function curveWeights(c: Curve | undefined, n: number): number[] | string {
  if (!Number.isInteger(n) || n < 1) return 'Enter how many payouts.';
  const kind = c?.kind ?? 'linear';
  const t = (i: number) => (n === 1 ? 0 : i / (n - 1));
  switch (kind) {
    case 'linear':
      return Array(n).fill(1);
    case 'front':
    case 'back': {
      const r = c?.steepness ?? DEFAULT_STEEPNESS;
      if (!(r >= 1 && r <= MAX_STEEPNESS)) return `Steepness must be between 1 and ${MAX_STEEPNESS}.`;
      // Exponential: first and last differ by ×r.
      return Array.from({ length: n }, (_, i) => (kind === 'front' ? r ** -t(i) : r ** t(i)));
    }
    case 's-curve': {
      const k = c?.steepness ?? DEFAULT_S_STEEPNESS;
      if (!(k > 0 && k <= 50)) return 'S-curve steepness must be between 0 and 50.';
      // Slices of a logistic: slow, then fast, then slow.
      const F = (x: number) => 1 / (1 + Math.exp(-k * (x - 0.5)));
      return Array.from({ length: n }, (_, i) => F((i + 1) / n) - F(i / n));
    }
    case 'cliff': {
      const cl = c?.cliff ?? 0;
      if (!Number.isInteger(cl) || cl < 0) return 'Enter the cliff as a whole number of payouts.';
      if (cl >= n) return `The cliff (${cl}) must be shorter than the schedule (${n} payouts).`;
      // Vesting: nothing before the cliff, then the cliff payout catches up, then linear.
      return Array.from({ length: n }, (_, i) => (i < cl ? 0 : i === cl ? cl + 1 : 1));
    }
    case 'step': {
      const k = c?.every ?? 1;
      if (!Number.isInteger(k) || k < 1) return 'Enter the step as a whole number of payouts.';
      return Array.from({ length: n }, (_, i) => ((i + 1) % k === 0 ? k : i === n - 1 ? n % k : 0));
    }
    case 'custom': {
      const err = validateCustom(c?.pcts, n);
      return err ?? (c!.pcts as number[]);
    }
  }
}

/**
 * Split `total` integer units over `weights`: floor each share, the remainder on the last piece with a
 * non-zero weight. The result sums to `total` exactly.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, b) => a + b, 0);
  if (!(W > 0)) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((total * w) / W));
  let last = weights.length - 1;
  while (last > 0 && !(weights[last] > 0)) last--;
  out[last] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

/**
 * Pieces under `min` are not worth claiming: each folds into the next kept piece (paid later, never
 * earlier), and a too-small last piece folds back into the one before. Zero pieces are dropped.
 * Returns the kept indexes and their amounts (same sum), and how many pieces were merged.
 */
export function mergeSmall(amounts: number[], min: number): { idx: number[]; amounts: number[]; merged: number } {
  const idx: number[] = [];
  const out: number[] = [];
  let carry = 0;
  let merged = 0;
  amounts.forEach((a, i) => {
    if (a <= 0) return;
    const v = a + carry;
    if (v < min && i < amounts.length - 1) {
      carry = v;
      merged++;
      return;
    }
    carry = 0;
    idx.push(i);
    out.push(v);
  });
  if (carry > 0) {
    // Only possible when the last non-zero piece was folded but a zero followed it.
    if (out.length) out[out.length - 1] += carry;
    else {
      idx.push(amounts.length - 1);
      out.push(carry);
    }
  }
  if (out.length > 1 && out[out.length - 1] < min) {
    out[out.length - 2] += out.pop() as number;
    idx.pop();
    merged++;
  }
  return { idx, amounts: out, merged };
}

/** Is the sequence non-increasing / non-decreasing? (for tests and the preview hint) */
export const nonIncreasing = (a: number[]) => a.every((x, i) => i === 0 || x <= a[i - 1]);
export const nonDecreasing = (a: number[]) => a.every((x, i) => i === 0 || x >= a[i - 1]);
