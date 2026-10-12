import { describe, expect, test } from 'bun:test';
import { hueTurnFor, shownHueFor } from './cardHue';

describe('standard hue slider', () => {
  test('no turn shows gold', () => expect(shownHueFor(0)).toBe(45));
  test('round-trips across the spectrum', () => {
    for (const h of [0, 45, 90, 180, 225, 359]) expect(shownHueFor(hueTurnFor(h))).toBe(h);
  });
  test('turns stay in -180..180', () => {
    for (const h of [0, 120, 224, 225, 226, 359]) {
      const t = hueTurnFor(h);
      expect(t).toBeGreaterThanOrEqual(-180);
      expect(t).toBeLessThan(180);
    }
  });
});
