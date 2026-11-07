/**
 * Release click-through, 4 Nov 2026: once the move notice showed on the phone and web home (F-D), it showed on EVERY
 * open: it asks at mount, before the wallet has an account context, and the background then said "not on this
 * device"; the next ask was a minute later. Now the background answers "not ready" until the wallet is open (the notice
 * shows nothing), and the notice asks every 5 s until it knows the account is on this device, then every minute.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NOTICE_FAST_POLL_MS, noticePollMs } from './moveToDevice';

describe('the move notice at start-up', () => {
  test('asks every 5 s while unknown or not on this device, every minute once on it', () => {
    expect(noticePollMs(null, 60_000)).toBe(NOTICE_FAST_POLL_MS);
    expect(noticePollMs({ onDevice: false }, 60_000)).toBe(NOTICE_FAST_POLL_MS);
    expect(noticePollMs({ onDevice: true }, 60_000)).toBe(60_000);
    expect(NOTICE_FAST_POLL_MS).toBe(5_000);
  });

  test('the notice polls through noticePollMs, with plain-number dependencies (no re-run per render)', () => {
    const src = readFileSync(join(import.meta.dir, 'MoveToDeviceNotice.tsx'), 'utf8');
    expect(src).toContain('const every = noticePollMs(status, pollMs);');
    expect(src).toMatch(/setInterval\(\(\) => void load\(\), every\);[\s\S]*?\}, \[load, every\]\);/);
  });

  test('the background answers "not ready" before the wallet is open, never "not on this device"', () => {
    const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
    const start = bg.indexOf("case 'STORAGE_MOVE_STATUS':");
    const handler = bg.slice(start, bg.indexOf("case 'STORAGE_MOVE_TO_DEVICE':", start));
    const guard = handler.indexOf('if (!accountContext)');
    expect(guard).toBeGreaterThan(0);
    expect(handler.indexOf("success: false, error: 'The wallet is still opening'")).toBeGreaterThan(guard);
    expect(guard).toBeLessThan(handler.indexOf('data: moveStatus()'));
  });
});
