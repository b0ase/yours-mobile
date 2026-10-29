/** Swipe maths for the Store showcase carousel (pure, tested in swipe.test.ts). */

/** Shortest signed distance from the current card to card n on the loop. */
export const loopOffset = (n: number, i: number, len: number) => {
  let d = (((n - i) % len) + len) % len;
  if (d > len / 2) d -= len;
  return d;
};

/** How many cards a released drag moves: past ~20% of a card or a quick flick steps; a fast fling can step up to 3. */
export const dragSteps = (dx: number, vx: number, cardW: number) => {
  if (cardW <= 0) return 0;
  const projected = dx + vx * 220; // momentum: where the card would coast to
  let steps = Math.round(-projected / cardW);
  if (steps === 0 && (Math.abs(dx) > cardW * 0.2 || Math.abs(vx) > 0.45))
    steps = dx < 0 || (dx === 0 && vx < 0) ? 1 : -1;
  if (dx < 0 && steps < 0) steps = 0;
  if (dx > 0 && steps > 0) steps = 0;
  return Math.max(-3, Math.min(3, steps));
};
