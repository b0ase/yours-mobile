/**
 * F-C (release click-through, 4 Nov 2026): Recover change on a freshly restored account, or while an open moves the
 * account, waits for the move ("Waiting for your backup…") instead of refusing, and never shows the toolbox's raw
 * "does not support StorageProvider" error.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { recoverOnDevice, STILL_ON_BACKUP_MESSAGE, storeNotReady, WAITING_FOR_BACKUP } from './recoverOnDevice';
import { REMOTE_ACTIVE_REFUSAL } from './seedChangeWiring';

const RAW = 'Active "WalletStorageProvider" does not support "StorageProvider" interface.';
type Report = { error?: string; done?: boolean };

function world(o: { local: boolean; moveWorks?: boolean | 'after-1' }) {
  const s = { local: o.local, moves: 0, runs: 0, steps: [] as string[] };
  return {
    s,
    deps: {
      isLocal: () => s.local,
      moveNow: async () => {
        s.moves++;
        if (o.moveWorks === true || (o.moveWorks === 'after-1' && s.moves > 1)) s.local = true;
        return s.local;
      },
      progress: (m: string) => void s.steps.push(m),
    },
  };
}

describe('Recover change waits for the move to this device', () => {
  test('on this device already: runs at once, no waiting', async () => {
    const { s, deps } = world({ local: true });
    const r = await recoverOnDevice<Report>({ ...deps, run: async () => (s.runs++, { done: true }) });
    expect(r).toEqual({ ran: true, report: { done: true } });
    expect(s.moves).toBe(0);
    expect(s.steps).toEqual([]);
  });

  test('freshly restored (remote active): says "Waiting for your backup…", moves the account, then runs', async () => {
    const { s, deps } = world({ local: false, moveWorks: true });
    const r = await recoverOnDevice<Report>({
      ...deps,
      run: async () => {
        expect(s.local).toBe(true); // never runs against the remote store (07b L1)
        s.runs++;
        return { done: true };
      },
    });
    expect(r).toEqual({ ran: true, report: { done: true } });
    expect(s.steps).toEqual([WAITING_FOR_BACKUP]);
    expect(s.moves).toBe(1);
    expect(s.runs).toBe(1);
  });

  test('the backup never answers: a plain message, nothing run, never a refusal to lock and unlock', async () => {
    const { s, deps } = world({ local: false, moveWorks: false });
    const r = await recoverOnDevice<Report>({ ...deps, run: async () => (s.runs++, {}) });
    expect(r).toEqual({ ran: false, message: STILL_ON_BACKUP_MESSAGE });
    expect(s.runs).toBe(0);
    expect(STILL_ON_BACKUP_MESSAGE).not.toMatch(/StorageProvider|Lock and unlock/);
  });

  test('the store changes under the run (the raw toolbox error): waits for the move and runs again', async () => {
    const { s, deps } = world({ local: true, moveWorks: true });
    const r = await recoverOnDevice<Report>({
      ...deps,
      run: async () => {
        s.runs++;
        if (s.runs === 1) {
          s.local = false; // an open's move made the remote active while the run waited for the storage locks
          throw new Error(RAW);
        }
        return { done: true };
      },
    });
    expect(r).toEqual({ ran: true, report: { done: true } });
    expect(s.runs).toBe(2);
    expect(s.moves).toBe(1);
    expect(s.steps).toEqual([WAITING_FOR_BACKUP]);
  });

  test("the run's own refusal (remote active) is waited out, and twice in a row ends in plain words", async () => {
    const once = world({ local: true, moveWorks: true });
    let n = 0;
    const r1 = await recoverOnDevice<Report>({
      ...once.deps,
      run: async () => (++n === 1 ? ((once.s.local = false), { error: REMOTE_ACTIVE_REFUSAL }) : { done: true }),
    });
    expect(r1).toEqual({ ran: true, report: { done: true } });

    const twice = world({ local: true, moveWorks: true });
    const r2 = await recoverOnDevice<Report>({ ...twice.deps, run: async () => ({ error: RAW }) });
    expect(r2).toEqual({ ran: false, message: STILL_ON_BACKUP_MESSAGE });
  });

  test('other errors and reports pass through unchanged', async () => {
    const { deps } = world({ local: true });
    expect(await recoverOnDevice<Report>({ ...deps, run: async () => ({ error: 'WhatsOnChain is down' }) })).toEqual({
      ran: true,
      report: { error: 'WhatsOnChain is down' },
    });
    await expect(
      recoverOnDevice<Report>({
        ...deps,
        run: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(storeNotReady(RAW)).toBe(true);
    expect(storeNotReady(`Couldn’t run: ${REMOTE_ACTIVE_REFUSAL}`)).toBe(true);
    expect(storeNotReady('Paused: checked 3 coins')).toBe(false);
  });

  test('the background runs Recover change through this gate and never sends its raw error', () => {
    const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
    const start = bg.indexOf('const processRecoverSeedChange');
    const body = bg.slice(start, bg.indexOf('\n  };', start));
    expect(body).toContain('recoverOnDevice(');
    expect(body).toContain('moveToDeviceNow');
  });
});
