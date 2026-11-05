/**
 * services/deviceActive.ts on a stand-in manager (the real toolbox end to end is incident/notActive.test.ts): when it
 * heals, when it retries, what it says, what it sets aside and reconnects, and what it leaves alone.
 */
import { describe, expect, test } from 'bun:test';
import { sdk } from '@bsv/wallet-toolbox-client';
import {
  DeviceNotActiveError,
  ensureBackupConnected,
  isManagerNotActive,
  keepDeviceStoreActive,
  switchActiveAs,
} from './deviceActive';
import { classifySendError, DEVICE_NOT_ACTIVE_MESSAGE } from '../utils/sendErrors';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);

/** A backup connection, as the toolbox's StorageClient: settings cached after the first answer; up, down or hung. */
function client(name = 'backup') {
  const net = { state: 'up' as 'up' | 'down' | 'hung', requests: 0 };
  const settings = { storageIdentityKey: name };
  let cached: typeof settings | undefined;
  const answer = async <T>(v: T): Promise<T> => {
    net.requests++;
    if (net.state === 'down') throw new Error(`network: ${name} did not answer`);
    if (net.state === 'hung') await new Promise(() => undefined);
    return v;
  };
  const c = {
    isStorageProvider: () => false,
    makeAvailable: async () => cached ?? (cached = await answer(settings)),
    findOrInsertUser: (identityKey: string) => answer({ user: { identityKey } }),
  };
  return { c, net, settings };
}

/**
 * Like WalletStorageManager: makeAvailable partitions the stores (a backup whose user row names another store is a
 * conflicting active) and every active call is refused, as getAuth(true), while one is. `inner` replaces a call's body.
 */
function manager(o: { conflicting?: boolean; deviceSelected?: boolean } = {}) {
  const calls: string[] = [];
  const namesOther = new Set<string>(o.conflicting ? ['backup'] : []);
  const inner: Record<string, (() => Promise<unknown>) | undefined> = {};
  const backup = client();
  type S = { storage: unknown; settings?: { storageIdentityKey?: string } };
  const m = {
    _authId: { identityKey: 'id' },
    _stores: [
      { storage: 'device', settings: { storageIdentityKey: 'device' } },
      { storage: backup.c, settings: backup.settings },
    ] as S[],
    _conflictingActives: [] as S[],
    _isAvailable: true,
    get isActiveEnabled() {
      return this._conflictingActives.length === 0;
    },
    isActiveStorageProvider: () => o.deviceSelected ?? true,
    getConflictingStores: () => m._conflictingActives.map((s) => s.settings?.storageIdentityKey ?? ''),
    getBackupStores: () =>
      m._stores
        .slice(1)
        .filter((s) => !namesOther.has(s.settings?.storageIdentityKey ?? ''))
        .map((s) => s.settings?.storageIdentityKey ?? ''),
    makeAvailable: async () => {
      m._conflictingActives = m._stores.slice(1).filter((s) => namesOther.has(s.settings?.storageIdentityKey ?? ''));
      m._isAvailable = true;
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
  void m.makeAvailable();
  return {
    m,
    calls,
    inner,
    backup,
    /** Another device's open re-points this backup (seen only when the stores are read again). */
    namesOther,
    /** The toolbox's setActive for this device: a request to every backup, then every store names this device. */
    setDeviceActive: async () => {
      for (const s of m._stores.slice(1)) await (s.storage as ReturnType<typeof client>['c']).findOrInsertUser('id');
      namesOther.clear();
      await m.makeAvailable();
    },
  };
}
const quiet = { log: () => undefined };
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
const stores = (f: ReturnType<typeof manager>) => f.m._stores.map((s) => s.settings?.storageIdentityKey);

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

  test('a heal still running when the wait ends: the build is refused at once, "Nothing was sent", nothing built', async () => {
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
    expect((e as DeviceNotActiveError).code).toBe('WERR_NOT_ACTIVE');
    expect((e as Error).message).toBe(DEVICE_NOT_ACTIVE_MESSAGE);
    const info = classifySendError(e);
    expect(info).toMatchObject({ kind: 'device-not-active', moneyMoved: 'no' });
    expect(info.message).toMatch(/Nothing was sent\. Try again/);
    release();
  });

  test('a refused build after a heal that could not enable the store says "Nothing was sent", with the reason behind Details', async () => {
    const f = manager({ conflicting: true, deviceSelected: true });
    keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: async () => undefined,
      ...quiet,
    });
    // Nothing to set aside (the device's own row names another store): the toolbox keeps refusing.
    f.m._conflictingActives = [];
    Object.defineProperty(f.m, 'isActiveEnabled', { get: () => false });
    const e = await f.m.createAction().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeviceNotActiveError);
    expect((e as DeviceNotActiveError).detail).toMatch(/not accessing user's active storage/);
    expect(classifySendError(e).detail).toMatch(/not accessing user's active storage/);
    const p = await f.m.processAction().catch((x: unknown) => x); // after signing: the toolbox's error, unchanged
    expect(p).not.toBeInstanceOf(DeviceNotActiveError);
    expect(isManagerNotActive(p)).toBe(true);
  });

  test('a merge that fails sets the backup aside, so this device pays; it is never reattached in the same run', async () => {
    const f = manager({ conflicting: true });
    f.backup.net.state = 'down';
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: f.setDeviceActive,
      retryMs: [60_000],
      ...quiet,
    })!;
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
    expect(stores(f)).toEqual(['device']);
    expect(keep.paused()).toMatchObject({ paused: true, failures: 1 });
    // Device sync's connect step right after (the same run): no reconnect, no request to the dead backup.
    const before = f.backup.net.requests;
    expect(await ensureBackupConnected({ storage: f.m, keep, url: 'u', addRemote: async () => undefined })).toBe(false);
    expect(f.backup.net.requests).toBe(before);
    expect(stores(f)).toEqual(['device']);
    keep.stop();
  });

  test('F1: reconnecting while the backup is still down (settings cached) never adds it: reads and payments go on', async () => {
    const f = manager({ conflicting: true });
    f.backup.net.state = 'down';
    // The handshake answered earlier, so its settings are cached (as the real StorageClient's are).
    f.backup.net.state = 'up';
    await f.backup.c.makeAvailable();
    f.backup.net.state = 'down';
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: f.setDeviceActive,
      retryMs: [1],
      ...quiet,
    })!;
    await f.m.createAction();
    keep.stop(); // drive the retries by hand
    await sleep(5);
    expect(await keep.reattach()).toBe(false); // the probe (a real request) failed
    expect(stores(f)).toEqual(['device']);
    expect(f.m.isActiveEnabled).toBe(true);
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
  });

  test('F1: a probe to a hung backup ends at its deadline, and the backup stays aside', async () => {
    const f = manager({ conflicting: true });
    f.backup.net.state = 'down';
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: f.setDeviceActive,
      retryMs: [1],
      backupCallMs: 30,
      ...quiet,
    })!;
    await f.m.createAction();
    f.backup.net.state = 'hung';
    await sleep(5);
    const t0 = Date.now();
    keep.stop();
    expect(await keep.reattach()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(stores(f)).toEqual(['device']);
  });

  test('F4: a set-aside backup reconnects by itself on its back-off once it answers, and is merged again', async () => {
    const f = manager({ conflicting: true });
    f.backup.net.state = 'down';
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: f.setDeviceActive,
      retryMs: [20, 20],
      ...quiet,
    })!;
    await f.m.createAction();
    expect(keep.paused().paused).toBe(true);
    await sleep(40); // one retry while still down
    expect(keep.paused().paused).toBe(true);
    expect(keep.paused().failures).toBeGreaterThanOrEqual(2);
    f.backup.net.state = 'up';
    for (let i = 0; i < 50 && keep.paused().paused; i++) await sleep(10);
    expect(keep.paused().paused).toBe(false);
    expect(stores(f)).toEqual(['device', 'backup']);
    expect(f.m.isActiveEnabled).toBe(true);
    expect(f.namesOther.size).toBe(0); // merged: the backup names this device again
    keep.stop();
  });

  test('F2: every backup request in a heal has a deadline; a hung merge ends, the backup is set aside, the payment goes out', async () => {
    const f = manager({ conflicting: true });
    f.backup.net.state = 'hung';
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      // The toolbox's setActive asks the backup through the client's own methods (which the heal bounds).
      setDeviceActive: f.setDeviceActive,
      backupCallMs: 30,
      retryMs: [60_000],
      ...quiet,
    })!;
    const t0 = Date.now();
    expect(await f.m.createAction()).toEqual({ reference: 'r1' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(stores(f)).toEqual(['device']);
    // The deadlines are on the client only for the heal.
    expect(Object.prototype.hasOwnProperty.call(f.backup.c, 'getSyncChunk')).toBe(false);
    keep.stop();
  });

  test('F3: an explicit switch waits for a running heal, and no heal undoes it afterwards', async () => {
    const f = manager({ conflicting: true });
    const order: string[] = [];
    let release: () => void = () => undefined;
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: async () => {
        order.push('heal start');
        await new Promise<void>((r) => (release = r));
        await f.setDeviceActive();
        order.push('heal end');
      },
      ...quiet,
    })!;
    const healing = keep.heal('test');
    await tick();
    const setActive = switchActiveAs(keep, async (target) => {
      order.push(`switch to ${target}`);
      f.namesOther.add('backup'); // the remote is the user's choice now: this device is no longer "the" active
      await f.m.makeAvailable();
    });
    const switching = setActive('https://wallet.1sat.test');
    await tick();
    expect(order).toEqual(['heal start']);
    release();
    await Promise.all([healing, switching]);
    expect(order).toEqual(['heal start', 'heal end', 'switch to https://wallet.1sat.test']);
    // A pending or later heal never flips it back.
    expect(keep.needsHeal()).toBe(false);
    await f.m.makeAvailable();
    await sleep(20);
    expect(order.length).toBe(3);
    // Back to this device, explicitly: heals apply again.
    await setActive('local');
    f.namesOther.add('backup');
    await f.m.makeAvailable();
    expect(keep.needsHeal()).toBe(true);
    keep.stop();
  });

  test('F5: the same backup registered twice is kept once; a set-aside backup already connected again is not re-added', async () => {
    const f = manager();
    const keep = keepDeviceStoreActive(f.m, {
      deviceIntended: () => true,
      setDeviceActive: f.setDeviceActive,
      ...quiet,
    })!;
    const again = client(); // a late connect or addRemote to the same backup
    f.m._stores = [...f.m._stores, { storage: again.c, settings: again.settings }];
    await f.m.makeAvailable();
    await sleep(20);
    expect(stores(f)).toEqual(['device', 'backup']);
    keep.stop();
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
      keep.stop();
    }
  });

  test('stores re-read into a conflict (a late connect) heal on their own, after the re-read, not inside it', async () => {
    const f = manager();
    const h = counted(f.setDeviceActive);
    const keep = keepDeviceStoreActive(f.m, { deviceIntended: () => true, setDeviceActive: h.fn, ...quiet })!;
    f.namesOther.add('backup');
    await f.m.makeAvailable();
    expect(h.count()).toBe(0); // never inside makeAvailable: setActive runs that under every storage lock
    expect(keep.needsHeal()).toBe(true);
    await tick();
    expect(h.count()).toBe(1);
    expect(keep.needsHeal()).toBe(false);
    keep.stop();
    f.namesOther.add('backup');
    await f.m.makeAvailable();
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

  test('ensureBackupConnected: a healthy backup needs nothing; none connected opens one; a conflict without a fix opens none', async () => {
    const f = manager();
    let adds = 0;
    const addRemote = async () => void adds++;
    expect(await ensureBackupConnected({ storage: f.m, keep: null, url: 'u', addRemote })).toBe(true);
    f.m._stores = f.m._stores.slice(0, 1);
    await f.m.makeAvailable();
    expect(await ensureBackupConnected({ storage: f.m, keep: null, url: 'u', addRemote })).toBe(false);
    expect(adds).toBe(1);
    const g = manager({ conflicting: true });
    expect(await ensureBackupConnected({ storage: g.m, keep: null, url: 'u', addRemote })).toBe(false);
    expect(adds).toBe(1);
    expect(await ensureBackupConnected({ storage: f.m, keep: null, url: undefined, addRemote })).toBe(false);
  });
});
