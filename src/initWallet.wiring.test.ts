/**
 * Review 16b/16c: the real initWallet wiring, not a regex over its source. One account (random 12 words) on a fake
 * extension store (chrome.storage stub, fake-indexeddb), WhatsOnChain answered by a stub that records every URL, and the
 * address sync held back. Then the wallet initWallet returns is driven as a site would drive it (with one confirmed
 * coin planted in the device store, so a module purchase gets as far as the pay sheet), and the device store initWallet
 * opened takes a page as a sync would deliver it, and works through its admission list with the real lookups.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb } from '@bsv/wallet-toolbox-client';
import { stubGlobals } from './testing/stubGlobals';
import { getKeys } from './utils/keys';
import { encrypt } from './utils/crypto';
import { CHROME_STORAGE_OBJECT_VERSION, ACCOUNT_DATA_VERSION } from './utils/constants';
import { HELD_ASSET_REFUSAL } from './services/pModuleSpendGate';
import { MODULE_PROBE_ANSWER, P_MODULE_PROTOCOL_REFUSAL } from './services/reservedProtocols';
import {
  NO_VERIFIER,
  _resetInboundVerifiers,
  _uninstallInboundSyncGuard,
  admissionListFor,
} from './services/inboundSync';

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
/** Transactions WhatsOnChain "has" (its /tx/hash answers 200), and outpoints it has as spent. */
const wocKnows = new Set<string>();
stubGlobals({
  chrome: {
    runtime: { lastError: undefined, id: 'test', sendMessage: async () => undefined, getURL: (p: string) => p },
    storage: { local: area(local), session: area(session), onChanged: { addListener: () => undefined } },
  },
  // No network: WhatsOnChain says "not found" to everything but the transactions it is told it has; URLs recorded.
  fetch: async (url: unknown) => {
    const u = String(url);
    if (u.includes('whatsonchain')) wocAsked.push(u);
    const hash = /\/tx\/hash\/([0-9a-f]{64})$/.exec(u)?.[1];
    if (hash && wocKnows.has(hash)) return new Response(JSON.stringify({ txid: hash }), { status: 200 });
    return new Response('', { status: 404 });
  },
});

const SITE = 'evil.example';
let ctx: Awaited<ReturnType<typeof import('./initWallet').initWallet>>;
let identityKey = '';
let root: PrivateKey;
const BRC29: [2, string] = [2, '3241645161d8'];

beforeAll(async () => {
  const keys = getKeys();
  const passKey = Utils.toHex(Random(32));
  root = PrivateKey.fromWif(keys.identityWif);
  identityKey = root.toPublicKey().toString();
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

  /** The device store initWallet opened, and this account's user in it. */
  const device = async () => {
    const d = (ctx.storage as unknown as { getActive(): StorageIdb }).getActive();
    const { userId } = (await d.findUsers({ partial: { identityKey } }))[0];
    return { d, userId };
  };
  /** Wallet change paying this account's own BRC-29 key (or a stranger's), its transaction mined, planted directly. */
  const plantChange = async (opts: { sats: number; spendable: boolean; stranger?: boolean }) => {
    const { d, userId } = await device();
    const derivationPrefix = Utils.toBase64(Random(8));
    const derivationSuffix = Utils.toBase64(Random(8));
    const key = new KeyDeriver(root).derivePublicKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, 'self', true);
    const script = new P2PKH().lock(opts.stranger ? PrivateKey.fromRandom().toAddress() : key.toAddress());
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: Utils.toHex(Random(32)),
      sourceOutputIndex: 0,
      unlockingScript: script,
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: script, satoshis: opts.sats });
    const txid = tx.id('hex');
    const merklePath = new MerklePath(900_000, [[{ offset: 0, hash: txid, txid: true }]]);
    const now = new Date();
    const provenTxId = await d.insertProvenTx({
      provenTxId: 0,
      created_at: now,
      updated_at: now,
      txid,
      height: 900_000,
      index: 0,
      merklePath: merklePath.toBinary(),
      rawTx: tx.toBinary(),
      blockHash: '00'.repeat(32),
      merkleRoot: merklePath.computeRoot(txid),
    } as never);
    const transactionId = await d.insertTransaction({
      transactionId: 0,
      created_at: now,
      updated_at: now,
      userId,
      status: 'completed',
      reference: Utils.toBase64(Random(12)),
      isOutgoing: false,
      satoshis: opts.sats,
      description: 'test coin',
      version: 1,
      lockTime: 0,
      txid,
      rawTx: tx.toBinary(),
      provenTxId,
    } as never);
    const basket = (await d.findOutputBaskets({ partial: { userId, name: 'default' } }))[0];
    const outputId = await d.insertOutput({
      outputId: 0,
      created_at: now,
      updated_at: now,
      userId,
      transactionId,
      basketId: basket.basketId,
      spendable: opts.spendable,
      change: true,
      outputDescription: '',
      vout: 0,
      satoshis: opts.sats,
      providedBy: 'storage',
      purpose: 'change',
      type: 'P2PKH',
      txid,
      derivationPrefix,
      derivationSuffix,
      lockingScript: script.toBinary(),
      scriptLength: script.toBinary().length,
      scriptOffset: 0,
    } as never);
    return { d, txid, outputId };
  };

  test("a site's module purchase is charged on the real pay sheet: the gate asks for what leaves the wallet", async () => {
    await plantChange({ sats: 20_000, spendable: true });
    // The 1Sat module's own sheet: approved (the background's prompt window would show it).
    const { initOneSatPromptBridge, handleOneSatPermissionResponse } = await import('./services/oneSatPrompt');
    initOneSatPromptBridge({ showPrompt: (id) => queueMicrotask(() => handleOneSatPermissionResponse(id, true)) });
    const sheets: { originator?: string; spending?: { satoshis?: number } }[] = [];
    const w = ctx.wallet as unknown as {
      bindCallback(n: string, f: (r: never) => void): void;
      denyPermission(id: string): Promise<void>;
    };
    w.bindCallback('onSpendingAuthorizationRequested', (r: { requestID: string }) => {
      sheets.push(r as never);
      void w.denyPermission(r.requestID); // the owner says no
    });
    await expect(ctx.wallet.createAction(pay(['p 1sat action']) as never, SITE)).rejects.toThrow();
    expect(sheets.length).toBe(1);
    expect(sheets[0].originator).toContain(SITE);
    expect(sheets[0].spending?.satoshis ?? 0).toBeGreaterThanOrEqual(1000); // the payout, plus the fee
    // Refused: nothing was signed, and the coin is free again.
    const { d, userId } = await device();
    expect((await d.findTransactions({ partial: { userId, status: 'unsigned' } })).length).toBe(0);
  });

  test("the inbound check guards the device store initWallet opened, with this account's own keys and lookups", async () => {
    const { d } = await device();
    const sik = d.getSettings().storageIdentityKey;
    // Another account's page into this device store: refused, never let through unchecked.
    await expect(
      d.processSyncChunk(
        {
          identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
          fromStorageIdentityKey: 'b',
          toStorageIdentityKey: sik,
        } as never,
        { outputs: [] } as never,
      ),
    ).rejects.toThrow(NO_VERIFIER);
    // This account's page: a coin it has never seen goes on the admission list, and the merge asks nothing.
    const txid = Utils.toHex(Random(32));
    wocAsked.length = 0;
    await d
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
    expect(wocAsked).toEqual([]);
    expect((await admissionListFor(sik).list(identityKey)).map((e) => e.txid)).toContain(txid);
  });

  test("ctx.admitBackupRows: honest change (this account's root key) is admitted on the real lookups; a stranger's never", async () => {
    const mine = await plantChange({ sats: 7_000, spendable: false });
    const theirs = await plantChange({ sats: 9_000, spendable: false, stranger: true });
    wocKnows.add(mine.txid);
    wocKnows.add(theirs.txid);
    const sik = mine.d.getSettings().storageIdentityKey;
    await admissionListFor(sik).add(
      identityKey,
      [mine.txid, theirs.txid].map((t) => ({ kind: 'coin' as const, txid: t, vout: 0 })),
      Date.now(),
    );
    wocAsked.length = 0;
    const r = await ctx.admitBackupRows();
    expect(r?.admitted).toBe(1);
    const { d, userId } = await device();
    expect((await d.findOutputs({ partial: { userId, outputId: mine.outputId } }))[0].spendable).toBe(true);
    expect((await d.findOutputs({ partial: { userId, outputId: theirs.outputId } }))[0].spendable).toBe(false);
    expect(wocAsked.some((u) => u.includes(`/tx/${mine.txid}/0/spent`))).toBe(true);
    expect(wocAsked.some((u) => u.includes(theirs.txid))).toBe(false); // refused on the key check, before the chain
  });

  test('every device-sync pull schedules the admission list after the merge, without awaiting it (review 18, F-A)', () => {
    const src = readFileSync(new URL('./initWallet.ts', import.meta.url), 'utf8');
    const pull = src.slice(src.indexOf('    pull: pullThenAdmitSoon('), src.indexOf('    push: async () => {'));
    expect(pull).toMatch(/await storage\.syncFromReader\([\s\S]*\},\s*\(\) => admitIn\(0\)/);
    expect(pull).not.toContain('await admitBackupRows()');
  });

  test("this device's store is kept active (P0, 5 Nov 2026), under the coin check, which wraps over it", async () => {
    const m = ctx.storage as unknown as {
      __bwxDeviceActive?: { needsHeal(): boolean };
      __bwxCoinPreflight?: boolean;
      isActiveEnabled: boolean;
    };
    expect(m.__bwxDeviceActive).toBeDefined();
    expect(m.isActiveEnabled).toBe(true);
    expect(m.__bwxDeviceActive!.needsHeal()).toBe(false);
    expect(m.__bwxCoinPreflight).toBe(true);
    // Installed first: the coin check's createAction calls through it (initWallet installs it before the check).
    const src = readFileSync(new URL('./initWallet.ts', import.meta.url), 'utf8');
    expect(src.indexOf('keepDeviceStoreActive(storage')).toBeGreaterThan(0);
    expect(src.indexOf('keepDeviceStoreActive(storage')).toBeLessThan(src.indexOf('installCoinPreflightForWallet('));
  });
});
