/**
 * The card-back pad's output for fixed touches (cardPadVectors.ts). bit-sign's in-page pad is a port of this code
 * (bit-sign src/lib/card-pad.ts) and its card-pad-selftest.mts expects these same paths, byte for byte.
 */
import { expect, test } from 'bun:test';
import { PAD_VECTORS } from './cardPadVectors';
import { SIG_H, SIG_W, signatureFromStrokes, strokesToPath, toBoxPoint } from './signature';
import { signatureSvg } from '../pair/bitsign';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('the saved SVG for each fixed input (pinned, shared with bit-sign)', () => {
  const out: Record<string, string> = {};
  for (const v of PAD_VECTORS) {
    const box = v.strokes.map((s) => ({
      pen: s.pen,
      points: s.points.map(([x, y, p]) => toBoxPoint(x, y, p, v.w, v.h)),
    }));
    const path = signatureFromStrokes(box, SIG_W, SIG_H);
    expect(path.length).toBeGreaterThan(0);
    // The saved SVG, and the live preview (outline tolerance 0) drawn from the same points.
    out[v.name] = `${sha(signatureSvg(path))} ${sha(strokesToPath(box, 0))}`;
  }
  if (process.env.PRINT_PAD_VECTORS) console.log(JSON.stringify(out, null, 2));
  expect(out).toEqual(PINNED);
});

// sha256 of the saved SVG and of the live preview path, as bWalletX draws them (pinned in bit-sign too).
const PINNED: Record<string, string> = {
  'finger, one wave':
    'e96c84e9f3b713a3cec642c3390e690ac531634e57815a5a8d57c5b862b1f75f 22a9261cfb064d0073f6aa412ec3735b927eec8c395f157975521d1a317d0109',
  'finger, two strokes + a dot':
    'a04276bc85bd3cf5e0ac7efbb454a1a515841a9fb768db9f083138a06b5054e6 7d9aa5f343036254c56996eb1d87dceefbc38f50bf7ba4ef69829c73f0981ccd',
  'pen with pressure':
    'ebad5e58de78ab28d4483896ee7398296d100e609ed7263ddffb9a9da4f2e31f 55a5e50b7a4566240b3db0d8f8df0e3bcd4087d59f6338e2db132ec5363e26cd',
  'two points only':
    'a501d0030310de7c679a771e5ebbb6f793412a44b147c95254f4759e805983f9 98359dc1d119b66ebb8c4ab6cfbd1b2b17f612548feada463b856cb62c82ad02',
};
