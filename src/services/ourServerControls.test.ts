/**
 * The background's controls for our storage server (review of a95a1ff0, 1 and 4): Settings › Storage "Make active",
 * every remote a restore / repair / reconcile reads from, the store switch inside "Restore from backup", the
 * STORAGE_GET_INFO refusals and sign-out. The background builds its handlers from these (checked below against its
 * source), so removing a call there or a rule here fails a test.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ourServerControls, signOutStores } from './ourServerControls';
import { OUR_SERVER_ACTIVE_REFUSAL } from './spendableFirstWiring';
import { SNAPSHOT_MARK_KEY, SNAPSHOT_SERVER_URL } from './spendableFirst';

const ONESAT = 'https://wallet.1sat.app';
const ADDR = '1Acct';
const KEY = `${SNAPSHOT_MARK_KEY(ADDR)}:ourBackupCheck`;

const make = (o: { flag?: boolean; record?: unknown; heldOut?: boolean; ctx?: boolean } = {}) => {
  const store: Record<string, unknown> = o.record ? { [KEY]: o.record } : {};
  return ourServerControls({
    flagOn: async () => o.flag ?? false,
    kv: { get: async (k: string) => ({ [k]: store[k] }) },
    identityAddress: () => ADDR,
    ctx: () => (o.ctx === false ? null : { deviceStoreKey: () => 'dev', ourBackupHeldOut: () => o.heldOut ?? true }),
  });
};
const repaired = { deviceSik: 'dev', check: 'repaired', at: 1 };

describe('ourServerControls', () => {
  test('Make active (and any store switch to a remote) refuses our server unless flag on and repaired here', async () => {
    let switched: string[] = [];
    const set = async (t: string) => void switched.push(t);
    for (const c of [
      make(),
      make({ flag: true }),
      make({ record: repaired }),
      make({ flag: true, record: repaired, ctx: false }),
    ]) {
      switched = [];
      await expect(c.guardSetActive(set)(SNAPSHOT_SERVER_URL)).rejects.toThrow(OUR_SERVER_ACTIVE_REFUSAL);
      await expect(c.guardSetActive(set)('https://Storage.bwalletx.com.')).rejects.toThrow(OUR_SERVER_ACTIVE_REFUSAL);
      expect(switched).toEqual([]);
      await c.guardSetActive(set)('local');
      await c.guardSetActive(set)(ONESAT);
      expect(switched).toEqual(['local', ONESAT]);
    }
    switched = [];
    await make({ flag: true, record: repaired }).guardSetActive(set)(SNAPSHOT_SERVER_URL);
    expect(switched).toEqual([SNAPSHOT_SERVER_URL]);
  });

  test('restore / repair / reconcile read from a safe remote only (1Sat removed: none)', async () => {
    expect(await make().pickRemote({ remotes: [SNAPSHOT_SERVER_URL] })).toBeUndefined();
    expect(await make().pickRemote({ remotes: [`${SNAPSHOT_SERVER_URL}/`, ONESAT] })).toBe(ONESAT);
    expect(await make({ flag: true }).pickRemote({ remotes: [SNAPSHOT_SERVER_URL, ONESAT] })).toBe(ONESAT);
    expect(await make({ flag: true, heldOut: false }).pickRemote({ remotes: [SNAPSHOT_SERVER_URL, ONESAT] })).toBe(
      SNAPSHOT_SERVER_URL,
    );
    // The account's active store is its store (a move away from it reads it).
    expect(await make().pickRemote({ activeRemote: SNAPSHOT_SERVER_URL, remotes: [] })).toBe(SNAPSHOT_SERVER_URL);
    // No wallet open: never our server.
    expect(await make({ flag: true, ctx: false }).pickRemote({ remotes: [SNAPSHOT_SERVER_URL] })).toBeUndefined();
  });

  test('STORAGE_GET_INFO: the remotes whose Make active is refused, with why', async () => {
    expect(await make().refusedActive({ remotes: [ONESAT, `${SNAPSHOT_SERVER_URL}.`] })).toEqual({
      [`${SNAPSHOT_SERVER_URL}.`]: OUR_SERVER_ACTIVE_REFUSAL,
    });
    expect(
      await make({ flag: true, record: repaired }).refusedActive({ remotes: [ONESAT, SNAPSHOT_SERVER_URL] }),
    ).toEqual({});
  });

  test('sign-out: wallet dropped, pass key cleared, stores deleted, key and repair records forgotten, cache too', async () => {
    const steps: string[] = [];
    const store: Record<string, unknown> = { storageIdentityKey: 'k', [KEY]: repaired, accounts: {} };
    const cache: { storageIdentityKey?: string } = { storageIdentityKey: 'k' };
    await signOutStores({
      dropWallet: () => void steps.push('drop'),
      clearPassKey: async () => void steps.push('passKey'),
      deleteDatabases: async () => void steps.push('databases'),
      area: {
        get: async () => ({ ...store }),
        remove: async (keys: string[]) => {
          steps.push('records');
          for (const k of keys) delete store[k];
        },
      },
      cache: () => cache,
    });
    expect(steps).toEqual(['drop', 'passKey', 'databases', 'records']);
    expect(Object.keys(store)).toEqual(['accounts']);
    expect(cache.storageIdentityKey).toBeUndefined();
  });
});

describe('the background routes its handlers through ourServerControls', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  const handler = (start: string, end: string) => {
    const i = bg.indexOf(start);
    expect(i).toBeGreaterThan(0);
    return bg.slice(i, bg.indexOf(end, i + start.length));
  };
  test('switchActiveStorage, restoreDeps.setActiveStorage, signOut, STORAGE_GET_INFO and every remote pick', () => {
    expect(handler('const switchActiveStorage = async', 'switchActiveStorageRef =')).toContain(
      'ourControls.guardSetActive(',
    );
    expect(handler('const restoreDeps = ', 'summarize:')).toContain('ourControls.guardSetActive(');
    expect(handler('const signOut = async', '};')).toContain('signOutStores(');
    expect(
      handler(
        'const processStorageGetInfo = async',
        "sendResponse({\n          type: 'STORAGE_GET_INFO',\n          success: true",
      ),
    ).toContain('ourControls.refusedActive(');
    expect(handler('const processRestoreBackup = async', 'if (remoteUrl)')).toContain('ourControls.pickRemote(');
    expect(handler('const processRecoverMined = async', 'if (account && config && remoteUrl)')).toContain(
      'ourControls.pickRemote(',
    );
    // No raw first-remote pick is left anywhere in the background.
    expect(bg).not.toMatch(/activeRemote \|\| [a-zA-Z?.]*remotes/);
  });
});
