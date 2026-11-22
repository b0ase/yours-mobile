/**
 * Run by initWallet.wiring.test.ts in its OWN process (review of f42df01f / 6888544a): the real initWallet with our
 * storage server held out for its one-time repair, and the storage identity key's correction. A process of its own so
 * nothing it leaves running (initWallet's fire-and-forget sweeps and syncs) can touch another test file's stubs, and
 * another file's leftovers can't touch it: no dependence on file order or load.
 *
 * No network and no DNS, provably: fetch is replaced BEFORE anything imports @bsv/sdk (its SimplifiedFetchTransport
 * keeps the fetch it finds at import), and every fetch and node:dns lookup is recorded and refused. Prints one line,
 * `RESULT <json>`, and exits (ending anything still running).
 */
import dns from 'node:dns';

const fetched: string[] = [];
const lookedUp: string[] = [];
const refuse = (what: string) => new Error(`no network in this test: ${what}`);
(globalThis as Record<string, unknown>).fetch = async (url: unknown) => {
  fetched.push(String(url instanceof Request ? url.url : url));
  throw refuse(String(url));
};
const dnsCalls = (name: string) =>
  ((host: string, ...rest: unknown[]) => {
    lookedUp.push(`${name}:${host}`);
    const cb = rest.find((r) => typeof r === 'function') as ((e: Error) => void) | undefined;
    if (cb) return cb(refuse(host));
    return Promise.reject(refuse(host));
  }) as never;
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6'] as const) {
  (dns as unknown as Record<string, unknown>)[k] = dnsCalls(k);
  (dns.promises as unknown as Record<string, unknown>)[k] = dnsCalls(`promises.${k}`);
}

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
(globalThis as Record<string, unknown>).chrome = {
  runtime: { lastError: undefined, id: 'test', sendMessage: async () => undefined, getURL: (p: string) => p },
  storage: { local: area(local), session: area(session), onChanged: { addListener: () => undefined } },
};

const UNREACHABLE = 'https://backup.invalid';

async function main() {
  await import('fake-indexeddb/auto');
  const { Random, Utils } = await import('@bsv/sdk');
  const { StorageIdb, StorageProvider } = await import('@bsv/wallet-toolbox-client');
  const { getKeys } = await import('../utils/keys');
  const { encrypt } = await import('../utils/crypto');
  const { CHROME_STORAGE_OBJECT_VERSION, ACCOUNT_DATA_VERSION } = await import('../utils/constants');
  const { SNAPSHOT_MARK_KEY, SNAPSHOT_SERVER_URL, SPENDABLE_FIRST_KEY } = await import('../services/spendableFirst');
  const { ourBackupCheckKey } = await import('../services/spendableFirstWiring');
  const { ChromeStorageService } = await import('../services/ChromeStorage.service');
  const { initWallet, ourServerHeldOut, storageIdentityKeyFor } = await import('../initWallet');

  const keys = getKeys();
  const address = keys.identityAddress;
  const passKey = Utils.toHex(Random(32));
  Object.assign(local, {
    version: CHROME_STORAGE_OBJECT_VERSION,
    deviceId: 'test-device',
    selectedAccount: address,
    [SPENDABLE_FIRST_KEY]: true,
    accounts: {
      [address]: {
        name: 'Held',
        icon: '',
        network: 'mainnet',
        encryptedKeys: await encrypt(JSON.stringify(keys), passKey),
        derivationTags: [],
        settings: {},
        addresses: { identityAddress: address, ordAddress: keys.ordAddress, bsvAddress: keys.walletAddress },
        balance: {},
        mneeBalance: {},
        pubKeys: { identityPubKey: keys.identityPubKey, ordPubKey: keys.ordPubKey, bsvPubKey: keys.walletPubKey },
        dataVersion: ACCOUNT_DATA_VERSION,
        storageConfig: { remotes: [SNAPSHOT_SERVER_URL, UNREACHABLE] },
      },
    },
  });
  session.passKey = passKey;
  // The device store already exists with its own key, and the top-level key is a stale one (an earlier build made a
  // fresh key per open): the open must keep the device store's key from then on.
  const DEVICE_KEY = 'yours-dev1ce5torek3y';
  const pre = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  await pre.migrate('wallet', DEVICE_KEY);
  (pre as unknown as { db?: { close(): void } }).db?.close();
  local.storageIdentityKey = 'yours-0000000000000000';
  const open = () =>
    initWallet(new ChromeStorageService(), { startSyncsAfter: () => new Promise<void>(() => undefined) });
  const deviceKey = (ctx: Awaited<ReturnType<typeof open>>) =>
    (
      (ctx.storage as unknown as { _stores: { storage: unknown }[] })._stores
        .map((m) => m.storage)
        .find((st): st is InstanceType<typeof StorageIdb> => st instanceof StorageIdb) as InstanceType<
        typeof StorageIdb
      >
    ).getSettings().storageIdentityKey;

  // 1. Held out: no 'repaired' record on this device.
  const first = await open();
  const r: Record<string, unknown> = {};
  r.deviceKey = deviceKey(first) === DEVICE_KEY;
  r.heldOut = first.ourBackupHeldOut();
  r.backupConfigured = first.backupState().backupConfigured;
  r.connectedBackups = first.storage.getBackupStores().length;
  const before = fetched.length;
  r.storePayment = await first.backupBeforeSend();
  r.fetchedDuringPayment = fetched.slice(before);
  const dev = deviceKey(first);
  // 2. The stale top-level key was corrected to the device store's own, and is read back through the account-object
  //    path, where the repair's record (written with the device store's key) is found.
  r.keyCorrected = local.storageIdentityKey === dev;
  await first.close();
  const svc = new ChromeStorageService();
  await svc.getAndSetStorage();
  const sik = await storageIdentityKeyFor(svc);
  r.keyRead = sik === dev;
  const account = svc.getCurrentAccountObject().account;
  r.heldOutNoRecord = await ourServerHeldOut(account, undefined, [SNAPSHOT_SERVER_URL], sik);
  local[ourBackupCheckKey(SNAPSHOT_MARK_KEY(address))] = { deviceSik: dev, check: 'repaired', at: 1 };
  r.heldOutRepaired = await ourServerHeldOut(account, undefined, [SNAPSHOT_SERVER_URL], sik);
  delete local[ourBackupCheckKey(SNAPSHOT_MARK_KEY(address))];

  // 3. Whatever the active store; never when our server IS the active store (and in any spelling).
  const acct = { addresses: { identityAddress: 'acct-x' } };
  r.heldOutRemoteActive = await ourServerHeldOut(acct, UNREACHABLE, [SNAPSHOT_SERVER_URL], 'sik');
  r.heldOutOursActive = await ourServerHeldOut(acct, 'https://Storage.bwalletx.com.', [UNREACHABLE], 'sik');
  r.heldOutSpelled = await ourServerHeldOut(acct, undefined, ['https://storage.bwalletx.com%2e/'], 'sik');
  local[ourBackupCheckKey(SNAPSHOT_MARK_KEY('acct-x'))] = { deviceSik: 'sik', check: 'repaired', at: 1 };
  r.heldOutRemoteActiveRepaired = await ourServerHeldOut(acct, UNREACHABLE, [SNAPSHOT_SERVER_URL], 'sik');

  r.fetched = fetched;
  r.lookedUp = lookedUp;
  console.log(`RESULT ${JSON.stringify(r)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log(`RESULT ${JSON.stringify({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })}`);
    process.exit(1);
  },
);
