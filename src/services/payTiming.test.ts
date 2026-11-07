import { describe, expect, test } from 'bun:test';
import { payTimer } from './payTiming';

describe("payTimer: where an own payment's time goes (owner's seal, 7 Nov 2026: one createAction took ~25 s)", () => {
  test('marks are the time since the previous mark; the line names each and the total', () => {
    let t = 10_000;
    const timer = payTimer(() => t);
    t += 120;
    timer.mark('usb');
    t += 640;
    timer.mark('funding');
    t += 24_000;
    timer.mark('wallet');
    expect(timer.line('own createAction')).toBe(
      '[payTiming] own createAction: usb 120 ms, funding 640 ms, wallet 24000 ms; total 24760 ms',
    );
    expect(timer.total()).toBe(24_760);
  });
  test('no marks: just the total', () => {
    let t = 0;
    const timer = payTimer(() => t);
    t += 5;
    expect(timer.line('x')).toBe('[payTiming] x: total 5 ms');
  });
});
