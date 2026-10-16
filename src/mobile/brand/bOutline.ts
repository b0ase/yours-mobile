/**
 * The outline b as a pathfinder UNION (owner, 16 Oct 2026): one outer path around the merged stem + bowl, and the
 * counter as its own circle, so no stem lines cut into the bowl. Geometry matches the old overlapping drawing
 * (stem polygon 27..45 × 12..76, bowl r=31 and counter r=15 at 60,72). viewBox "20 6 80 104"; scales to any size.
 */
export const B_OUTLINE_VIEWBOX = '20 6 80 104';
/** Outer edge: stem top, down its right side to where it meets the bowl, round the bowl, back along the stem foot. */
export const B_OUTLINE_OUTER = 'M27 30 L45 12 L45 44.87 A31 31 0 1 1 29.26 76 L27 76 Z';
/** Counter (the hole). */
export const B_OUTLINE_COUNTER = 'M75 72 A15 15 0 1 1 45 72 A15 15 0 1 1 75 72 Z';
export const B_OUTLINE_D = `${B_OUTLINE_OUTER} ${B_OUTLINE_COUNTER}`;
