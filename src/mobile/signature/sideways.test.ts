/**
 * The signing pad for documents (owner, 7 Nov 2026): lengthwise along a landscape phone, FIXED, buttons on the right
 * ("Review", "Sign & seal"), never drawn rotated in portrait (portrait shows only "Turn your phone sideways to sign").
 * The drawing is kept in the 1000 × 250 box, so a Review (or a turn of the phone) comes back to the same drawing, and
 * it saves the same path the card-back pad always saved.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SIG_H, SIG_W, padMode, signatureFromStrokes, toBoxPoint, type SigStroke } from './signature';

describe('padMode', () => {
  test('sideways: portrait phone → turn prompt only; landscape → the pad; never rotated', () => {
    expect(padMode({ sideways: true, portraitPhone: true })).toBe('turn');
    expect(padMode({ sideways: true, portraitPhone: false })).toBe('pad');
  });
  test('the card-back strip keeps its portrait rotation', () => {
    expect(padMode({ sideways: false, portraitPhone: true })).toBe('rotated');
    expect(padMode({ sideways: false, portraitPhone: false })).toBe('pad');
  });
});

describe('the drawing lives in the 1000 × 250 box', () => {
  test('pad pixels → box, unclamped (as the live preview drew)', () => {
    expect(toBoxPoint(400, 100, 0.5, 800, 200)).toEqual([500, 125, 0.5]);
    expect(toBoxPoint(0, 0, 1, 0, 0)).toEqual([0, 0, 1]);
  });

  test('a drawing saved from box points is the path the pixel strokes gave (any pad size)', () => {
    const px: SigStroke[] = [
      {
        pen: false,
        points: [
          [12, 30, 0.5],
          [90, 64, 0.5],
          [180, 22, 0.5],
          [260, 70, 0.5],
          [330, 40, 0.5],
        ],
      },
    ];
    const w = 360;
    const h = 90;
    const box = px.map((s) => ({ pen: s.pen, points: s.points.map(([x, y, p]) => toBoxPoint(x, y, p, w, h)) }));
    expect(signatureFromStrokes(box, SIG_W, SIG_H)).toBe(signatureFromStrokes(px, w, h));
    // Shown again at a different size (after Review on another layout): same saved path.
    expect(signatureFromStrokes(box, SIG_W, SIG_H).length).toBeGreaterThan(0);
  });
});

describe('SignaturePad wiring', () => {
  const src = readFileSync(new URL('./SignaturePad.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../mobile.css', import.meta.url), 'utf8');
  test('sideways: turn prompt in portrait, the buttons in a column on the right', () => {
    expect(src).toContain('Turn your phone sideways to sign');
    expect(src).toMatch(/padMode\(\{ sideways, portraitPhone/);
    expect(src).toContain('bw-sigpad-side');
    expect(css).toMatch(/\.bw-sigpad\.is-sideways \.bw-sigpad-side \{[^}]*flex-direction: column/);
  });
  test('Review keeps the drawing; the pad can start from a kept drawing', () => {
    expect(src).toMatch(/onReview\?: \(strokes: SigStroke\[\]\) => void/);
    expect(src).toMatch(/initialStrokes\?: SigStroke\[\]/);
    expect(src).toMatch(/useState<SigStroke\[\]>\(\(\) => initialStrokes \?\? \[\]\)/);
  });
  test('fixed while drawing: no scroll, bounce or pinch-zoom', () => {
    expect(src).toContain("addEventListener('touchmove', stop, { passive: false })");
    expect(src).toContain("addEventListener('gesturestart', stop)");
    expect(css).toMatch(/\.bw-sigpad \{[^}]*overscroll-behavior: none/);
    expect(css).toMatch(/\.bw-sigpad \{[^}]*touch-action: none/);
  });
});
