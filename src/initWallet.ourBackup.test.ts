/**
 * Our storage server held out of the session for its one-time repair, through the REAL initWallet (review of b936a98c,
 * 6 and 7): its backupBeforeSend / backupConfigured / heldOut wiring, and the mobile fallback that opens without backups.
 * One account (random keys) on a fake extension store, the instant-restore flag on, our server saved with another
 * backup that can't connect (skipped at open, as an iPhone WebView refused by 1Sat is), no 'repaired' record.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Random, Utils } from '@bsv/sdk';
import { StorageIdb } from '@bsv/wallet-toolbox-client';
import { stubGlobals } from './testing/stubGlobals';
import { getKeys } from './utils/keys';
import { encrypt } from './utils/crypto';
import { CHROME_STORAGE_OBJECT_VERSION, ACCOUNT_DATA_VERSION } from './utils/constants';
import { _resetInboundVerifiers, _uninstallInboundSyncGuard } from './services/inboundSync';
import { SNAPSHOT_MARK_KEY, SNAPSHOT_SERVER_URL, SPENDABLE_FIRST_KEY } from './services/spendableFirst';
import { OUR_BACKUP_REBUILDING_REFUSAL, ourBackupCheckKey } from './services/spendableFirstWiring';

type Store = Record<string, unknown>;
const local: Store = {};
const session: Store = {};
const pick = (s: Store, keys: unknown) => {
  if (keys === null || keys === undefined) return structuredClone(s);
  const out: Store = {};
  for (const k of typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys as object))
    if (k in s) out[k] = structuredClone(s[k]);
  return out;
};
const area = (s: Store) => ({
  get: (keys: unknown, cb?: (r: Store) => void) => (cb ? cb(pick(s, keys)) : Promise.resolve(pick(s, keys))),
  set: (obj: Store, cb?: () => void) => {
    Object.assign(s, structuredClone(obj));
    return cb ? cb() : Promise.resolve();
  },
  remove: (keys: string | string[], cb?: () => void) => {
    for (const k of typeof keys === 'string' ? [keys] : keys) delete s[k];
    return cb ? cb() : Promise.resolve();
  },
});
const asked: string[] = [];
stubGlobals({
  chrome: {
    runtime: { lastError: undefined, id: 'test', sendMessage: async () => undefined, getURL: (p: string) => p },
    storage: { local: area(local), session: area(session), onChanged: { addListener: () => undefined } },
  },
  fetch: async (url: unknown) => {
    asked.push(String(url));
    return new Response('', { status: 404 });
  },
});

/** Another saved backup that can't connect (.invalid never resolves: no request leaves this machine). */
const ONESAT = 'https://backup.invalid';
let ctx: Awaited<ReturnType<typeof import('./initWallet').initWallet>>;
let identityAddress = '';

beforeAll(async () => {
  const keys = getKeys();
  identityAddress = keys.identityAddress;
  const passKey = Utils.toHex(Random(32));
  Object.assign(local, {
    version: CHROME_STORAGE_OBJECT_VERSION,
    deviceId: 'test-device',
    selectedAccount: keys.identityAddress,
    [SPENDABLE_FIRST_KEY]: true,
    accounts: {
      [keys.identityAddress]: {
        name: 'Test',
        icon: '',
        network: 'mainnet',
        encryptedKeys: await encrypt(JSON.stringify(keys), passKey),
        derivationTags: [],
        settings: {},
        addresses: {
          identityAddress: keys.identityAddress,
          ordAddress: keys.ordAddress,
          bsvAddress: keys.walletAddress,
        },
        balance: {},
        mneeBalance: {},
        pubKeys: { identityPubKey: keys.identityPubKey, ordPubKey: keys.ordPubKey, bsvPubKey: keys.walletPubKey },
        dataVersion: ACCOUNT_DATA_VERSION,
        storageConfig: { remotes: [SNAPSHOT_SERVER_URL, ONESAT] },
      },
    },
  });
  session.passKey = passKey;
  const { ChromeStorageService } = await import('./services/ChromeStorage.service');
  const { initWallet } = await import('./initWallet');
  ctx = await initWallet(new ChromeStorageService(), { startSyncsAfter: () => new Promise(() => undefined) });
}, 60_000);

afterAll(async () => {
  await ctx?.close?.().catch(() => undefined);
  _uninstallInboundSyncGuard(StorageIdb);
  _resetInboundVerifiers();
});

describe('initWallet: our server held out for its repair (review of b936a98c, 6 and 7)', () => {
  test('no repaired record: our server is never connected, and it is held out', () => {
    expect(local[ourBackupCheckKey(SNAPSHOT_MARK_KEY(identityAddress))]).toBeUndefined();
    expect(asked.some((u) => u.startsWith(SNAPSHOT_SERVER_URL))).toBe(false);
    expect(ctx.ourBackupHeldOut()).toBe(true);
  });

  test('a Store payment is refused with the honest line, never a push to nothing (no other backup connected)', async () => {
    // Configured backups, not the session's: fail closed.
    expect(ctx.backupState().backupConfigured).toBe(true);
    const before = asked.length;
    expect(await ctx.backupBeforeSend()).toEqual({ ok: false, error: OUR_BACKUP_REBUILDING_REFUSAL });
    // Refused before any push or reconnect was tried.
    expect(asked.slice(before)).toEqual([]);
  });

  test('held out whatever the active store (review of b936a98c, 3); never when our server IS the active store', async () => {
    const { ourServerHeldOut } = await import('./initWallet');
    const acct = { addresses: { identityAddress: 'acct-x' } };
    // Another backup active, our server saved, no record: held out (a move to this device never finds it attached).
    expect(await ourServerHeldOut(acct, ONESAT, [SNAPSHOT_SERVER_URL], 'sik')).toBe(true);
    // Our server is the active store (not among the backups): never held out, the account opens on it as before.
    expect(await ourServerHeldOut(acct, SNAPSHOT_SERVER_URL, [ONESAT], 'sik')).toBe(false);
    local[ourBackupCheckKey(SNAPSHOT_MARK_KEY('acct-x'))] = { deviceSik: 'sik', check: 'repaired', at: 1 };
    expect(await ourServerHeldOut(acct, ONESAT, [SNAPSHOT_SERVER_URL], 'sik')).toBe(false);
    expect(await ourServerHeldOut(acct, undefined, [SNAPSHOT_SERVER_URL], 'sik')).toBe(false);
  });
});
