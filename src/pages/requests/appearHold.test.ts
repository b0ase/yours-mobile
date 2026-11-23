import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { APPEAR_HOLD_MS, holdsOnAppear, sheetControls } from './sheetControls';

describe('a new pay or red sheet holds Allow as it appears (review of #558, L7)', () => {
  test('pay, careful, post and sign-once cards hold; sign-in and connect cards do not', () => {
    for (const k of ['pay', 'careful', 'post', 'signonce']) expect(holdsOnAppear(k)).toBe(true);
    for (const k of ['signin', 'connect', 'private']) expect(holdsOnAppear(k)).toBe(false);
    expect(APPEAR_HOLD_MS).toBeGreaterThanOrEqual(500);
    // While held, Allow is off and No stays available.
    expect(sheetControls({ busy: false, armed: true, hold: true, mustRead: false })).toEqual({
      allowDisabled: true,
      denyDisabled: false,
    });
  });

  test('BundleSheet holds on every new bundle (a queued PAY sheet promoted into the same window included)', () => {
    const sheet = readFileSync(resolve(import.meta.dir, 'BundleSheet.tsx'), 'utf8');
    expect(sheet).toContain('}, [request.bundleID]);');
    expect(sheet).toContain('const held = hold || (appearing && holdsOnAppear(kind));');
    expect(sheet).toContain('sheetControls({ busy, armed, hold: held, mustRead })');
    // The sheet sends the lines it showed, so a line joining mid-tap never makes the answer stale (L5).
    expect(sheet).toContain('seenIDs: seenItems(choice).map((r) => r.requestID),');
  });
});
