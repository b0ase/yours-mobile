import { describe, expect, it } from 'bun:test';
import { dockBottom } from './miniDock';

const box = (top: number, height: number, width = 390) => ({ top, bottom: top + height, height, width });

describe('mini player docks above the bottom nav', () => {
  it('sits above the tab bar, including the home indicator below it', () => {
    // 844 tall phone: tab bar 60 px ending 34 px above the bottom (home indicator).
    const b = dockBottom(box(0, 844), [box(750, 60)])!;
    expect(b).toBe(844 - 750 + 8);
    // The mini player's bottom edge is at or above the nav's top: it never covers nav buttons.
    expect(844 - b).toBeLessThanOrEqual(750);
  });
  it('uses the tallest bar when several are shown, at any width', () => {
    for (const w of [320, 390, 768, 1440]) {
      const b = dockBottom(box(0, 900, w), [box(840, 60, w), box(812, 88, w)])!;
      expect(900 - b).toBeLessThanOrEqual(812);
    }
  });
  it('works inside a smaller container (extension panel)', () => {
    const b = dockBottom(box(100, 600, 360), [box(640, 60, 360)])!;
    expect(700 - b).toBeLessThanOrEqual(640);
  });
  it('falls back when no nav is visible', () => {
    expect(dockBottom(box(0, 800), [])).toBeNull();
    expect(dockBottom(box(0, 800), [box(0, 0, 0)])).toBeNull();
    expect(dockBottom(null, [box(740, 60)])).toBeNull();
  });
});
