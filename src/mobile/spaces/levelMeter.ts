const BARS = 4;
/** Each bar's share of the meter: the middle bars reach highest, like a voice. */
const SHAPE = [0.55, 1, 0.8, 0.45];
const MIN = 0.18;

/**
 * Map a LiveKit audio level (0..1, speech mostly sits under 0.3) to bar heights (MIN..1).
 * A square-root curve lifts quiet speech so the bars move for normal talking.
 */
export function levelToBars(level: number, bars = BARS): number[] {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const v = Math.min(1, Math.sqrt(l) * 1.6);
  return Array.from({ length: bars }, (_, i) => {
    const h = MIN + (1 - MIN) * v * (SHAPE[i % SHAPE.length] ?? 1);
    return Math.round(h * 100) / 100;
  });
}
