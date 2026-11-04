/**
 * Review 16b: the real initWallet wiring, not a regex over its source. One account (random 12 words) on a fake
 * extension store (chrome.storage stub, fake-indexeddb), WhatsOnChain answered by a stub that records every URL, and the
 * address sync held back. Then the wallet initWallet returns is driven as a site would drive it, and the device store
 * initWallet opened takes a page as a sync would deliver it.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Random, Utils } from '@bsv/sdk';
import { StorageIdb } from '@bsv/wallet-toolbox-client';
import { stubGlobals } from './testing/stubGlobals';
import { getKeys } from './utils/keys';
import { encrypt } from './utils/crypto';
import { CHROME_STORAGE_OBJECT_VERSION, ACCOUNT_DATA_VERSION } from './utils/constants';
import { HELD_ASSET_REFUSAL } from './services/pModuleSpendGate';
import { MODULE_PROBE_ANSWER, P_MODULE_PROTOCOL_REFUSAL } from './services/reservedProtocols';
import { NO_VERIFIER, _resetInboundVerifiers, _uninstallInboundSyncGuard } from './services/inboundSync';

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
/** chrome.storage area answering both styles: callback (ChromeStorageService) and promise (the rest of the code). */
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
const wocAsked: string[] = [];
stubGlobals({
  chrome: {
    runtime: { lastError: undefined, id: 'test', sendMessage: async () => undefined, getURL: (p: string) => p },
    storage: { local: area(local), session: area(session), onChanged: { addListener: () => undefined } },
  },
  // No network: WhatsOnChain says "not found" to everything, and the URL is recorded.
  fetch: async (url: unknown) => {
    const u = String(url);
    if (u.includes('whatsonchain')) wocAsked.push(u);
    return new Response('', { status: 404 });
  },
});

const SITE = 'evil.example';
let ctx: Awaited<ReturnType<typeof import('./initWallet').initWallet>>;
let identityKey = '';

beforeAll(async () => {
  const keys = getKeys();
  const passKey = Utils.toHex(Random(32));
  identityKey = PrivateKey.fromWif(keys.identityWif).toPublicKey().toString();
  Object.assign(local, {
    version: CHROME_STORAGE_OBJECT_VERSION,
    deviceId: 'test-device',
    selectedAccount: keys.identityAddress,
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

describe('the real initWallet wiring', () => {
  const pay = (labels: string[]) => ({
    description: 'Buy a rare ordinal',
    labels,
    outputs: [
      {
        lockingScript: new P2PKH().lock(new PrivateKey(99).toAddress()).toHex(),
        satoshis: 1000,
        outputDescription: 'payment to seller',
      },
    ],
  });

  test('the p-module gate sits on the permissions manager every site call reaches (through every outer guard)', async () => {
    await expect(ctx.wallet.createAction(pay(['p 1sat input id abc123']) as never, SITE)).rejects.toThrow(
      HELD_ASSET_REFUSAL,
    );
  });

  test('G2 holds on the real wallet, and the 1sat module probe answers with the fixed key', async () => {
    await expect(
      ctx.wallet.getPublicKey({ protocolID: [1, 'P 1sat'], keyID: 'x', counterparty: 'self' } as never, SITE),
    ).rejects.toThrow(P_MODULE_PROTOCOL_REFUSAL);
    const probe = (await ctx.wallet.getPublicKey(
      { protocolID: [0, 'p 1sat probe'], keyID: '1sat-module-probe', counterparty: 'self' } as never,
      SITE,
    )) as { publicKey: string };
    expect(probe.publicKey).toBe(MODULE_PROBE_ANSWER);
  });

  test("the inbound check guards the device store initWallet opened, with this account's own chain lookups", async () => {
    const device = (ctx.storage as unknown as { getActive(): StorageIdb }).getActive();
    expect(device).toBeInstanceOf(StorageIdb);
    const sik = device.getSettings().storageIdentityKey;
    // Another account's page into this device store: refused, never let through unchecked.
    await expect(
      device.processSyncChunk(
        {
          identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
          fromStorageIdentityKey: 'b',
          toStorageIdentityKey: sik,
        } as never,
        { outputs: [] } as never,
      ),
    ).rejects.toThrow(NO_VERIFIER);
    // This account's page: a coin it has never seen goes to the chain through the real WhatsOnChain lookups.
    const txid = Utils.toHex(Random(32));
    wocAsked.length = 0;
    await device
      .processSyncChunk(
        { identityKey, fromStorageIdentityKey: 'backup-under-test', toStorageIdentityKey: sik } as never,
        {
          outputs: [
            {
              outputId: 1,
              transactionId: 999,
              txid,
              vout: 0,
              satoshis: 5000,
              spendable: true,
              change: false,
              type: 'custom',
              providedBy: 'you',
              purpose: '',
              lockingScript: new P2PKH().lock(new PrivateKey(77).toAddress()).toBinary(),
              updated_at: new Date(),
            },
          ],
        } as never,
      )
      .catch(() => undefined); // the toolbox then refuses a page from a store it has no sync state for
    expect(wocAsked.some((u) => u.includes(`/tx/${txid}/0/spent`))).toBe(true);
  });
});
