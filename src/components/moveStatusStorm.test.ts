/**
 * Release click-through, 4 Nov 2026: with the wallet home open, MoveToDeviceNotice sent about 20,000
 * STORAGE_MOVE_STATUS messages a second to the background (728,065 in 45 s on the web build). Its default `send` was
 * an inline arrow, a new function on every render, so `load` (useCallback on [send]) and the polling effect re-ran on
 * every render, and every answer's new status object rendered again. DeviceDataNote had the same default.
 *
 * The repo has no DOM test renderer, so this pins the cause: both components default to the one module-level send (moveToDevice.ts), and no
 * component passes an inline `send`. The live check is the web build's message count (one STORAGE_MOVE_STATUS per
 * mount and per minute).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { moveStatusSend } from './moveToDevice';

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');

describe('STORAGE_MOVE_STATUS storm: the components ask with a stable send', () => {
  test('both components default to the one module-level send (moveToDevice.ts)', () => {
    expect(typeof moveStatusSend).toBe('function');
    for (const f of ['MoveToDeviceNotice.tsx', 'DeviceDataNote.tsx']) {
      expect(src(f)).toMatch(/^\s*send = moveStatusSend,$/m);
      expect(src(f)).toContain("from './moveToDevice'");
    }
  });

  test('no inline arrow default for send in either component', () => {
    for (const f of ['MoveToDeviceNotice.tsx', 'DeviceDataNote.tsx'])
      expect(src(f)).not.toMatch(/^\s*send = \([^)]*\) =>/m);
  });

  test('the notice polls through a callback that depends on send only', () => {
    const s = src('MoveToDeviceNotice.tsx');
    expect(s).toMatch(/useCallback\(async \(\) => \{[\s\S]*?\}, \[send\]\)/);
    expect(s).toMatch(/\}, \[load, pollMs\]\);/);
  });

  test('every mount uses the default (no inline send that would bring the loop back)', () => {
    const users = ['../pages/BsvWallet.tsx', '../pages/StorageStatus.tsx', '../mobile/themeStore/StoreBuy.tsx'];
    for (const f of users) {
      const s = src(f);
      expect(s).toContain('<MoveToDeviceNotice');
      expect(s).not.toMatch(/<MoveToDeviceNotice[^>]*send=\{/);
    }
    for (const f of ['ShowSeedWords.tsx', '../pages/onboarding/RestoreAccount.tsx'])
      expect(src(f)).not.toMatch(/<DeviceDataNote[^>]*send=\{/);
  });
});
