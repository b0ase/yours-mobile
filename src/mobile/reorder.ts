/** Returns a copy of `list` with the item at `from` moved to index `to` (destination clamped). */
export const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  const next = list.slice();
  if (from < 0 || from >= next.length) return next;
  const dest = Math.max(0, Math.min(next.length - 1, to));
  if (dest === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(dest, 0, item);
  return next;
};
