/**
 * services/deviceActive.ts on a stand-in manager (the real toolbox end to end is incident/notActive.test.ts): when it
 * heals, when it retries, what it says, and what it leaves alone.
 */
import { describe, expect, test } from 'bun:test';
import { sdk } from '@bsv/wallet-toolbox-client';
import { DeviceNotActiveError, isManagerNotActive, keepDeviceStoreActive } from './deviceActive';
import { classifySendError, DEVICE_NOT_ACTIVE_MESSAGE } from '../utils/sendErrors';

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Like WalletStorageManager: makeAvailable partitions the stores (a backup whose user row names another store is a
 * conflicting active) and every active call is refused, as getAuth(true), while one is. `inner` replaces a call's body.
 */
function manager(o: { conflicting?: boolean; deviceSelected?: boolean } = {}) {
  const calls: string[] = [];
  const namesOther = new Set<string>(o.conflicting ? ['backup'] : []);
  const inner: Record<string, (() => Promise<unknown>) | undefined> = {};
  const m = {
    _stores: [{ storage: 'device' }, { storage: 'backup' }],
    _conflictingActives: [] as { storage: string }[],
    _isAvailable: true,
    get isActiveEnabled() {
      return this._conflictingActives.length === 0;
    },
    isActiveStorageProvider: () => o.deviceSelected ?? true,
    getConflictingStores: () => m._conflictingActives.map((s) => s.storage),
    getBackupStores: () =>
      m._stores
        .slice(1)
        .filter((s) => !namesOther.has(s.storage))
        .map((s) => s.storage),
    makeAvailable: async () => {
      m._conflictingActives = m._stores.slice(1).filter((s) => namesOther.has(s.storage));
      m._isAvailable = true;
    },
    addWalletStorageProvider: async (s: string) => {
      m._stores.push({ storage: s });
      m._isAvailable = false;
      await m.makeAvailable();
    },
    runAsSync: async <T>(fn: (a: unknown) => Promise<T>) => fn(undefined),
    createAction: async () => {
      calls.push('createAction');
      if (inner.createAction) return inner.createAction();
      if (!m.isActiveEnabled) throw new sdk.WERR_NOT_ACTIVE();
      return { reference: 'r1' };
    },
    processAction: async () => {
      calls.push('processAction');
      if (inner.processAction) return inner.processAction();
      if (!m.isActiveEnabled) throw new sdk.WERR_NOT_ACTIVE();
      return { sendWithResults: [] };
    },
  };
  m._conflictingActives = m._stores.slice(1).filter((s) => namesOther.has(s.storage));
  return {
    m,
    calls,
    inner,
    /** Another device's open re-points this backup (seen only when the stores are read again). */
    namesOther,
    /** The toolbox's setActive for this device: merge, then every store names this device. */
    setDeviceActive: async () => {
      namesOther.clear();
      await m.makeAvailable();
    },
  };
}

const counted = (fn: () => Promise<void>) => {
  let n = 0;
  return {
    count: () => n,
    fn: async () => {
      n++;
      await fn();
    },
  };
};
const quiet = { log: () => undefined };

describe('keepDeviceStoreActive', () => {
  test('a conflicting backup is merged and this device made active before the payment is built; it runs once', async () => {
    const f = manager({ conflicting: true });
    const h = counted(f.setDeviceActive);
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet });
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
    expect(h.count()).toBe(1);
    expect(f.calls).toEqual(['createAction']);
  });

  test('refused as not active by the toolbox itself (its first step): heal, then exactly one more try', async () => {
    const f = manager();
    const h = counted(f.setDeviceActive);
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet });
    // A late connect lands while the call waits for the lock: the stores are re-read into a conflict, then refused.
    f.inner.processAction = async () => {
      f.inner.processAction = undefined;
      f.namesOther.add('backup');
      await f.m.makeAvailable();
      throw new sdk.WERR_NOT_ACTIVE();
    };
    expect(await f.m.processAction()).toEqual({ sendWithResults: [] });
    expect(f.calls).toEqual(['processAction', 'processAction']);
    expect(h.count()).toBe(1);
  });

  test('a build still refused says "Nothing was sent" (DeviceNotActiveError), classified as not sent', async () => {
    const f = manager({ conflicting: true });
    const h = counted(async () => undefined); // the merge "works" but another device keeps the backup pointed away
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet });
    const e = await f.m.createAction().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeviceNotActiveError);
    expect((e as DeviceNotActiveError).code).toBe('WERR_NOT_ACTIVE');
    expect((e as Error).message).toBe(DEVICE_NOT_ACTIVE_MESSAGE);
    expect((e as DeviceNotActiveError).detail).toMatch(/not accessing user's active storage/);
    const info = classifySendError(e);
    expect(info).toMatchObject({ kind: 'device-not-active', moneyMoved: 'no' });
    expect(info.message).toMatch(/Nothing was sent\. Try again/);
    expect(info.detail).toMatch(/not accessing user's active storage/); // the toolbox's reason, behind Details
    expect(h.count()).toBe(2); // before the build, and once more after the refusal
  });

  test('after signing (processAction) a still-refused call keeps the toolbox error: that step is not the build', async () => {
    const f = manager({ conflicting: true });
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: async () => undefined, ...quiet });
    const e = await f.m.processAction().catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(DeviceNotActiveError);
    expect(isManagerNotActive(e)).toBe(true);
  });

  test("a server's WERR_NOT_ACTIVE (it may have done work first) is never retried or reworded", async () => {
    const f = manager();
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: f.setDeviceActive, ...quiet });
    const server = new sdk.WERR_NOT_ACTIVE("this method requires the authenticated user's active storage provider");
    f.inner.createAction = async () => {
      throw server;
    };
    expect(await f.m.createAction().catch((x: unknown) => x)).toBe(server);
    expect(f.calls).toEqual(['createAction']);
    expect(isManagerNotActive(server)).toBe(false);
  });

  test('a merge that fails sets the conflicting backup aside for the session, so this device pays; reattach brings it back', async () => {
    const f = manager({ conflicting: true });
    let backupUp = false;
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: async () => {
        if (!backupUp) throw new Error('network: getSyncChunk failed');
        await f.setDeviceActive();
      },
      ...quiet,
    })!;
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
    expect(f.m._stores.map((s) => s.storage)).toEqual(['device']);
    expect(f.calls).toEqual(['createAction']);
    expect(keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: async () => undefined })).toBe(
      keep,
    ); // installed once per manager
    // Device sync reconnects it while it is still down: set aside again, the device still pays.
    expect(await keep.reattach()).toBe(false);
    expect(f.m._stores.map((s) => s.storage)).toEqual(['device']);
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
    // Back up: reconnected, merged, and a backup again.
    backupUp = true;
    expect(await keep.reattach()).toBe(true);
    expect(f.m._stores.map((s) => s.storage)).toEqual(['device', 'backup']);
    expect(f.m.isActiveEnabled).toBe(true);
  });

  test('an account still on the remote store, or a remote selected as active, is left to the move (localFirst)', async () => {
    for (const o of [
      { intended: false, selected: true },
      { intended: true, selected: false },
    ]) {
      const f = manager({ conflicting: true, deviceSelected: o.selected });
      const h = counted(f.setDeviceActive);
      const keep = keepDeviceStoreActive(f.m, { deviceIntended: () => o.intended, setDeviceActive: h.fn, ...quiet })!;
      expect(keep.needsHeal()).toBe(false);
      await f.m.processAction().catch(() => undefined);
      await tick();
      expect(h.count()).toBe(0);
    }
  });

  test('stores re-read into a conflict (a late connect) heal on their own, after the re-read, not inside it', async () => {
    const f = manager();
    const h = counted(f.setDeviceActive);
    const keep = keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet })!;
    f.namesOther.add('late-backup');
    await f.m.addWalletStorageProvider('late-backup');
    expect(h.count()).toBe(0); // never inside makeAvailable: setActive runs that under every storage lock
    expect(keep.needsHeal()).toBe(true);
    await tick();
    expect(h.count()).toBe(1);
    expect(keep.needsHeal()).toBe(false);
    keep.stop();
    f.namesOther.add('another');
    await f.m.addWalletStorageProvider('another');
    await tick();
    expect(h.count()).toBe(1); // stopped with the wallet
  });

  test('concurrent calls share one heal', async () => {
    const f = manager({ conflicting: true });
    const h = counted(async () => {
      await tick();
      await f.setDeviceActive();
    });
    keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet });
    await Promise.all([f.m.createAction(), f.m.processAction(), f.m.createAction()]);
    expect(h.count()).toBe(1);
  });

  test('a heal still running when the wait ends: the build is refused at once, before anything is built', async () => {
    const f = manager({ conflicting: true });
    let release: () => void = () => undefined;
    keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: () => new Promise<void>((r) => (release = r)),
      healWaitMs: 10,
      ...quiet,
    });
    const e = await f.m.createAction().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeviceNotActiveError);
    expect(f.calls).toEqual([]);
    release();
  });
});
