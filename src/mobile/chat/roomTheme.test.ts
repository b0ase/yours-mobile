import { describe, expect, it } from 'bun:test';
import { roomBubbles } from './roomTheme';

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('roomBubbles', () => {
  it('gives $TERRORNODE red bubbles and a pink accent, matched by ticker', () => {
    for (const t of ['TERRORNODE', '$TERRORNODE', 'terrornode', ' $terrornode ']) {
      const b = roomBubbles(t);
      expect(b?.mineBg).toBe('#B3121E');
      expect(b?.theirsBg).toBe('#3A0A10');
      expect(b?.accent).toBe('#FF4D6D');
    }
  });

  it('leaves every other room on the default look', () => {
    for (const t of ['BWALLETX', 'LOUNGE', 'TERROR', '', null, undefined]) expect(roomBubbles(t)).toBeNull();
  });

  it('keeps bubble text at WCAG AA contrast', () => {
    const b = roomBubbles('TERRORNODE')!;
    expect(contrast(b.mineText, b.mineBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(b.theirsText, b.theirsBg)).toBeGreaterThanOrEqual(4.5);
  });
});
