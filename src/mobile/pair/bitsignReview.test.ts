/**
 * "Review" on the wallet's pad (owner, 7 Nov 2026): a page that says it can take it (args.review: true) gets a Review
 * button on the pad; pressing it answers { action: 'review' } (the page shows the document, then asks again) and the
 * drawing is kept for that page and document. A page that didn't ask never sees it (Cancel stays "declined").
 */
import { describe, expect, test } from 'bun:test';
import {
  DRAW_REVIEW,
  handleBitsignCall,
  keepDrawing,
  takeKeptDrawing,
  validateDrawRequest,
  type DrawRequest,
} from './bitsign';

const O = 'https://www.bchatx.com';
const H = 'cd'.repeat(32);
const args = (extra: Record<string, unknown> = {}) => ({ origin: O, docHash: H, title: 'Brief', ...extra });

describe('Review', () => {
  test('capabilities say review is understood', async () => {
    expect(await handleBitsignCall('bitsign.capabilities', {}, O)).toMatchObject({
      result: { drawSignature: true, review: true },
    });
  });

  test('review flag: true only when the page sends exactly true', () => {
    expect((validateDrawRequest(args({ review: true }), O) as DrawRequest).review).toBe(true);
    expect((validateDrawRequest(args({ review: 'yes' }), O) as DrawRequest).review).toBe(false);
    expect((validateDrawRequest(args(), O) as DrawRequest).review).toBe(false);
  });

  test('Review on a page that asked → { action: "review" }, nothing else', async () => {
    const r = await handleBitsignCall('bitsign.drawSignature', args({ review: true }), O, async () => DRAW_REVIEW);
    expect(r).toEqual({ result: { action: 'review' } });
  });

  test('a review answer for a page that did not ask is a decline', async () => {
    const r = await handleBitsignCall('bitsign.drawSignature', args(), O, async () => DRAW_REVIEW);
    expect(r).toMatchObject({ error: { code: 'ERR_PERMISSION_DENIED', message: 'declined' } });
  });

  test('the drawing is kept for the same page and document only, once', () => {
    const req = validateDrawRequest(args({ review: true }), O) as DrawRequest;
    const strokes = [{ pen: false, points: [[1, 2, 0.5] as [number, number, number]] }];
    keepDrawing(req, strokes);
    expect(takeKeptDrawing({ ...req, docHash: 'ef'.repeat(32) })).toBeUndefined();
    expect(takeKeptDrawing({ ...req, origin: 'https://chat.bwalletx.com' })).toBeUndefined();
    expect(takeKeptDrawing(req)).toEqual(strokes);
    expect(takeKeptDrawing(req)).toBeUndefined();
  });
});
