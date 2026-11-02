import { describe, expect, test } from 'bun:test';
import { createBackoff, syncBackoffDelay } from './syncBackoff';

describe('sync back-off', () => {
  test('schedule: 15 s, 30 s, 60 s, 120 s, 240 s, then capped at 5 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map((n) => syncBackoffDelay(n))).toEqual([
      0, 15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });

  test('waits after a failure, and a success resets it', () => {
    let t = 0;
    const b = createBackoff({ now: () => t });
    expect(b.ready()).toBe(true);
    expect(b.fail()).toBe(15_000);
    expect(b.ready()).toBe(false);
    t += 14_999;
    expect(b.ready()).toBe(false);
    expect(b.remainingMs()).toBe(1);
    t += 1;
    expect(b.ready()).toBe(true);
    expect(b.fail()).toBe(30_000);
    expect(b.fail()).toBe(60_000);
    expect(b.failures()).toBe(3);
    b.succeed();
    expect(b.ready()).toBe(true);
    expect(b.failures()).toBe(0);
    expect(b.fail()).toBe(15_000);
  });
});
