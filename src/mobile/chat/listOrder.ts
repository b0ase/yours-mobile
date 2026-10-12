/**
 * Keep a list's order stable while the user scrolls (no rows jumping under the finger):
 * rows already shown keep their previous positions, new rows go on top in their own order,
 * and rows that left are dropped. When not scrolling the caller uses the fresh order as is.
 */
export const stableOrder = <T>(prevKeys: readonly string[], next: readonly T[], keyOf: (x: T) => string): T[] => {
  const pos = new Map(prevKeys.map((k, i) => [k, i]));
  const fresh = next.filter((x) => !pos.has(keyOf(x)));
  const known = next.filter((x) => pos.has(keyOf(x))).sort((a, b) => pos.get(keyOf(a))! - pos.get(keyOf(b))!);
  return [...fresh, ...known];
};
