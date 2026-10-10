import { describe, expect, test } from 'bun:test';
import { DEPOSIT_GAP, planAddressScan, resetSyncCursor, syncStoreName } from './addressScan';

describe('planAddressScan', () => {
  test('an address handed out on another device (past this device maxKeyIndex) is scanned', () => {
    // Owner, 10 Oct 2026: index 5 was handed out elsewhere; this device's maxKeyIndex was still 4.
    const plan = planAddressScan(4, 4 + DEPOSIT_GAP);
    expect(plan.count).toBeGreaterThan(5);
    expect(plan.count).toBe(4 + DEPOSIT_GAP + 1);
  });

  test('defaults to maxKeyIndex 4 plus the gap', () => {
    expect(planAddressScan(undefined, undefined)).toEqual({
      count: 4 + DEPOSIT_GAP + 1,
      through: 4 + DEPOSIT_GAP,
      resetCursor: true,
    });
  });

  test('first run after the upgrade rescans history once', () => {
    expect(planAddressScan(4, undefined).resetCursor).toBe(true);
  });

  test('no rescan when the window was already scanned', () => {
    expect(planAddressScan(4, 4 + DEPOSIT_GAP).resetCursor).toBe(false);
    expect(planAddressScan(4, 99).resetCursor).toBe(false);
  });

  test('a new address that widens the window triggers one rescan', () => {
    const before = planAddressScan(4, undefined);
    const after = planAddressScan(5, before.through);
    expect(after.resetCursor).toBe(true);
    expect(planAddressScan(5, after.through).resetCursor).toBe(false);
  });

  test('bad maxKeyIndex values are clamped', () => {
    expect(planAddressScan(-3, 0).count).toBe(DEPOSIT_GAP + 1);
    expect(planAddressScan(2.7, 0).through).toBe(2 + DEPOSIT_GAP);
  });
});

describe('resetSyncCursor', () => {
  test('matches the @1sat/actions store name', () => {
    expect(syncStoreName('02ab')).toBe('sync-processed-02ab');
  });

  test('no IndexedDB: nothing to reset', async () => {
    expect(await resetSyncCursor('02ab', undefined)).toBe(false);
  });

  test('deletes only the cursor record', async () => {
    const deleted: string[] = [];
    const db = {
      objectStoreNames: { contains: (n: string) => n === 'sync_state' },
      transaction: (store: string) => {
        const tx: Record<string, unknown> = {
          objectStore: (s: string) => ({ delete: (k: string) => deleted.push(`${s}:${k}`) }),
        };
        queueMicrotask(() => (tx.oncomplete as () => void)?.());
        expect(store).toBe('sync_state');
        return tx;
      },
      close: () => undefined,
    };
    const idb = {
      open: (name: string) => {
        expect(name).toBe('sync-processed-02ab');
        const req: Record<string, unknown> = { result: db };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    } as unknown as IDBFactory;
    expect(await resetSyncCursor('02ab', idb)).toBe(true);
    expect(deleted).toEqual(['sync_state:lastScore']);
  });
});
