/**
 * The outline b as a pathfinder UNION (owner, 16 Oct 2026): one outer path around the merged stem + bowl, and the
 * counter as its own circle, so no stem lines cut into the bowl. Geometry matches the old overlapping drawing
 * (bowl R=31 at 60,72; stem 29..45 with its left edge exactly tangent to the bowl at 29,72, so the outline has no step; one 45° chamfer on top; counter 0.45R concentric). Round joins give every corner the same radius. viewBox "20 6 80 104"; scales to any size.
 */
export const B_OUTLINE_VIEWBOX = '20 6 80 104';
/** Outer edge: stem top, down its right side to where it meets the bowl, round the bowl, back along the stem foot. */
export const B_OUTLINE_OUTER = 'M29 28 L45 12 L45 44.87 A31 31 0 1 1 29 72 Z';
/** Counter (the hole). */
export const B_OUTLINE_COUNTER = 'M74 72 A14 14 0 1 1 46 72 A14 14 0 1 1 74 72 Z';
export const B_OUTLINE_D = `${B_OUTLINE_OUTER} ${B_OUTLINE_COUNTER}`;
