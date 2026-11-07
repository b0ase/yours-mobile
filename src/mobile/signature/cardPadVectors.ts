/**
 * Fixed pad inputs (pad pixels, as SignaturePad records them) shared with bit-sign's in-page pad
 * (bit-sign src/lib/card-pad.ts, card-pad-selftest.mts carries the same inputs and the paths below). If either side's
 * stroke code changes, its test fails: the two pads must keep drawing the same signature from the same touches.
 */
import type { SigStroke } from './signature';

export type PadVector = { name: string; w: number; h: number; strokes: SigStroke[] };

const wave = (n: number, x0: number, dx: number, y0: number, amp: number, pen = false, p = 0.5): SigStroke => ({
  pen,
  points: Array.from({ length: n }, (_, i) => [
    x0 + i * dx,
    y0 + Math.round(amp * Math.sin(i / 2)),
    pen ? Math.round((0.3 + 0.5 * Math.abs(Math.sin(i / 3))) * 100) / 100 : p,
  ]),
});

export const PAD_VECTORS: PadVector[] = [
  { name: 'finger, one wave', w: 800, h: 200, strokes: [wave(40, 20, 18, 100, 40)] },
  {
    name: 'finger, two strokes + a dot',
    w: 640,
    h: 160,
    strokes: [wave(25, 30, 14, 60, 25), wave(12, 300, 20, 110, 15), { pen: false, points: [[600, 40, 0.5]] }],
  },
  { name: 'pen with pressure', w: 1000, h: 250, strokes: [wave(30, 40, 28, 120, 60, true)] },
  {
    name: 'two points only',
    w: 400,
    h: 100,
    strokes: [
      {
        pen: false,
        points: [
          [10, 10, 0.5],
          [380, 90, 0.5],
        ],
      },
    ],
  },
];
