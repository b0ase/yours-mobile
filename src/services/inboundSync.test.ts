/**
 * b-Aware A3 (0xzero, 25 Oct 2026): a hostile or compromised remote storage provider could forge spendable wallet
 * state on this device, because the toolbox's sync merge took its rows as sent.
 *
 * Local only: fake-indexeddb, the real toolbox (StorageIdb, WalletStorageManager, Wallet), a second StorageIdb
 * standing in for wallet.1sat.app, random keys, and a fake chain answer. The provider's rows are rewritten the way a
 * hostile server would answer getSyncChunk (directly in its tables), then this device pulls with syncFromReader, the
 * call device sync, F-C and the restore switch all use.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  Beef,
  KeyDeriver,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Random,
  Script,
  Transaction,
  Utils,
} from '@bsv/sdk';
import {
  Services,
  StorageIdb,
  StorageProvider,
  Wallet,
  WalletPermissionsManager,
  WalletStorageManager,
} from '@bsv/wallet-toolbox-client';
import { createWalletCore } from '@1sat/wallet';
import { summarizeActive, switchToLocalVerified } from './restoreFromRemote';
import {
  NO_VERIFIER,
  UNCHECKED_PAGE,
  _resetInboundVerifiers,
  installInboundSyncGuard,
  isWalletChange,
  registerInboundVerifier,
  walletOwnership,
} from './inboundSync';
import type { SpendState } from './unsentExpiry';

const HEIGHT = 971_004;
const BRC29: [2, string] = [2, '3241645161d8'];
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock services: ${String(p)}`);
          },
  },
) as never;

let n = 0;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

/** A mined tx paying `sats` to `script` (one output). */
const minedTx = (script: Script, sats: number) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: script, satoshis: sats });
  tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
  return tx;
};
const atomic = (tx: Transaction) => {
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return beef.toBinaryAtomic(tx.id('hex'));
};

/** A BRC-29 payment to the wallet (sender = the anyone key, like the paymail server), internalized. */
async function receive(w: Wallet, kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = minedTx(new P2PKH().lock(priv.toPublicKey().toAddress()), sats);
  await w.internalizeAction({
    tx: atomic(tx),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
      },
    ],
    description: 'Paymail payment',
  });
  return tx.id('hex');
}

/** A 1-sat token coin at a wallet key, its record naming that key and an amount. */
async function receiveToken(w: Wallet, kd: KeyDeriver) {
  const keyID = `tok-${++n}`;
  const pub = kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
  const tx = minedTx(new P2PKH().lock(pub.toAddress()), 1);
  await w.internalizeAction({
    tx: atomic(tx),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: 'tokens-test',
          customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID, amt: '100' }),
        },
      },
    ],
    description: 'Token in',
  });
  return tx.id('hex');
}

/** This phone (device store active) and its backup provider, two coins and a token pushed to the backup. */
async function phoneWithBackup() {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const tag = ++n;
  const remote = await store(`a3-remote-${tag}`);
  const phone = await store(`a3-phone-${tag}`);
  const sm = new WalletStorageManager(kd.identityKey, phone, [remote]);
  await sm.makeAvailable();
  await sm.setActive(phone.getSettings().storageIdentityKey);
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  const coin = await receive(wallet, kd, 50_000);
  const coin2 = await receive(wallet, kd, 70_000);
  const token = await receiveToken(wallet, kd);
  await sm.updateBackups();
  const chain: { answer: SpendState['state']; asked: string[] } = { answer: 'unclear', asked: [] };
  const unregister = registerInboundVerifier(phone.getSettings().storageIdentityKey, kd.identityKey, {
    owns: walletOwnership(root),
    spent: async (outpoint) => {
      chain.asked.push(outpoint);
      return chain.answer === 'spent' ? { state: 'spent', by: 'ff'.repeat(32) } : ({ state: chain.answer } as never);
    },
    log: () => undefined,
  });
  const pull = () => sm.syncFromReader(kd.identityKey, remote as never);
  const row = async (s: StorageIdb, txid: string) => (await s.findOutputs({ partial: { txid, vout: 0 } }))[0];
  /** What a hostile provider answers from now on: its row, rewritten, newer than the phone's. */
  const forge = async (txid: string, patch: Record<string, unknown>) => {
    const r = await row(remote, txid);
    await remote.updateOutput(r.outputId, { ...patch, updated_at: new Date(Date.now() + 3_600_000) } as never);
  };
  return { root, kd, remote, phone, sm, wallet, coin, coin2, token, chain, pull, row, forge, unregister };
}

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installInboundSyncGuard(StorageIdb);
});
afterAll(() => {
  uninstall();
  _resetInboundVerifiers();
});

describe('A3: rows from a remote store never become spendable unchecked', () => {
  test('a coin this device holds as spent is not made spendable again when the chain says it is spent', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never); // spent here
    await d.forge(d.coin, { spendable: true, spentBy: undefined });
    d.chain.answer = 'spent';
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
    expect(d.chain.asked).toEqual([`${d.coin}.0`]);
  });

  test('...and a genuine release from another device (the chain says unspent) still comes through', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'unspent';
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true);
  });

  test('an output of a transaction this device holds as failed is not brought back (WhatsOnChain 404 is not proof)', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateTransaction(mine.transactionId, { status: 'failed' } as never);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'unspent'; // what /spent says for a transaction the network never had
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
  });

  test('chain unreachable: the page is refused whole and taken on a later pull', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'unclear';
    await expect(d.pull()).rejects.toThrow(UNCHECKED_PAGE);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
    d.chain.answer = 'unspent';
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true);
  });

  test("a coin's record, script and change role are the device's: a rewritten token amount or a coin re-filed as change doesn't land", async () => {
    const d = await phoneWithBackup();
    const before = await d.row(d.phone, d.token);
    await d.forge(d.token, {
      customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID: 'attacker', amt: '1000000' }),
      type: 'P2PKH',
      change: true,
      providedBy: 'storage',
      purpose: 'change',
      lockingScript: new P2PKH().lock(new PrivateKey(77).toAddress()).toBinary(),
    });
    const coinBefore = await d.row(d.phone, d.coin);
    await d.forge(d.coin, { lockingScript: new P2PKH().lock(new PrivateKey(78).toAddress()).toBinary() });
    await d.pull();
    const after = await d.row(d.phone, d.token);
    expect(after.customInstructions).toBe(before.customInstructions);
    expect(after.change).toBe(before.change);
    expect(after.type).toBe(before.type);
    expect(after.purpose).toBe(before.purpose);
    expect(Utils.toHex(after.lockingScript ?? [])).toBe(Utils.toHex(before.lockingScript ?? []));
    expect(Utils.toHex((await d.row(d.phone, d.coin)).lockingScript ?? [])).toBe(
      Utils.toHex(coinBefore.lockingScript ?? []),
    );
    expect(d.chain.asked).toEqual([]); // nothing became spendable: no chain question
  });

  test('change the device never had, not paying a wallet key, arrives not spendable (never picked by a payment)', async () => {
    const d = await phoneWithBackup();
    // The provider plants a transaction and a "change" output paying someone else's key, in its default basket.
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const legitTx = (await d.remote.findTransactions({ partial: { userId, txid: d.coin } }))[0];
    const legitOut = await d.row(d.remote, d.coin);
    const planted = minedTx(new P2PKH().lock(new PrivateKey(66).toAddress()), 900_000);
    const ptxid = planted.id('hex');
    const later = new Date(Date.now() + 3_600_000);
    const transactionId = await d.remote.insertTransaction({
      ...legitTx,
      transactionId: 0,
      txid: ptxid,
      reference: Utils.toBase64(Random(12)),
      rawTx: planted.toBinary(),
      provenTxId: undefined,
      created_at: later,
      updated_at: later,
    } as never);
    await d.remote.insertOutput({
      ...legitOut,
      outputId: 0,
      transactionId,
      txid: ptxid,
      vout: 0,
      satoshis: 900_000,
      lockingScript: planted.outputs[0].lockingScript.toBinary(),
      derivationPrefix: Utils.toBase64(Random(8)),
      derivationSuffix: Utils.toBase64(Random(8)),
      spendable: true,
      spentBy: undefined,
      created_at: later,
      updated_at: later,
    } as never);
    expect(isWalletChange(await d.row(d.remote, ptxid))).toBe(true);
    await d.pull();
    const got = await d.row(d.phone, ptxid);
    expect(got).toBeDefined(); // kept, visible to repairs
    expect(got.spendable).toBe(false);
  });

  test("an honest restore: the wallet's own coins arrive spendable, checked offline (the chain is never asked)", async () => {
    const d = await phoneWithBackup();
    const fresh = await store(`a3-new-${++n}`);
    const unregister = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, {
      owns: walletOwnership(d.root),
      spent: async (op) => {
        d.chain.asked.push(op);
        return { state: 'unclear' };
      },
    });
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    for (const txid of [d.coin, d.coin2, d.token]) expect((await d.row(fresh, txid)).spendable).toBe(true);
    expect(d.chain.asked).toEqual([]);
    unregister();
  });

  test('the restore switch (factory with the backup active, then the toolbox copy into the device) still lands every coin', async () => {
    const d = await phoneWithBackup();
    const name = `a3-restore-${++n}`;
    const local = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    (local as unknown as { dbName: string }).dbName = name;
    await local.migrate(name, `sik-${name}`);
    const asked: string[] = [];
    const owns = walletOwnership(d.root);
    let checked = 0;
    const unregister = registerInboundVerifier(`sik-${name}`, d.kd.identityKey, {
      owns: async (row, script) => (checked++, owns(row, script)),
      spent: async (op) => (asked.push(op), { state: 'unclear' }),
    });
    const remoteUrl = 'https://wallet.1sat.test';
    (d.remote as unknown as { endpointUrl: string }).endpointUrl = remoteUrl;
    class FakeStorageClient {
      constructor() {
        return d.remote;
      }
    }
    const core = await createWalletCore(
      { privateKey: d.root.toWif(), chain: 'main', activeRemote: remoteUrl, backups: [] } as never,
      local,
      { Services, StorageClient: FakeStorageClient, StorageProvider, Wallet, WalletStorageManager } as never,
    );
    core.storage.setServices(services);
    (core.wallet as unknown as { services: unknown }).services = services;
    const r = await switchToLocalVerified({
      remoteUrl,
      activeRemoteUrl: () => core.storage.getStores().find((s) => s.isActive && !s.isConflicting)?.endpointURL,
      setActiveStorage: core.setActiveStorage,
      summarize: () => summarizeActive(core.wallet as never),
      pullRemote: async () => {
        await core.storage.syncFromReader((await core.storage.getAuth()).identityKey, d.remote as never);
      },
    });
    expect(r.ok).toBe(true);
    const spendable = (await local.findOutputs({ partial: {} })).filter((o) => o.spendable);
    expect(spendable.reduce((s, o) => s + o.satoshis, 0)).toBe(50_000 + 70_000 + 1);
    expect(checked).toBeGreaterThanOrEqual(3); // the copy went through the check: each coin, offline
    expect(asked).toEqual([]);
    unregister();
  });

  test('a device store with no check set up for the account refuses the page (fail closed)', async () => {
    const d = await phoneWithBackup();
    d.unregister();
    await expect(d.pull()).rejects.toThrow(NO_VERIFIER);
  });

  test('initWallet sets the check up before the wallet factory can merge anything', () => {
    const src = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    const opens = [...src.matchAll(/await createWebWallet\(/g)].map((m) => m.index ?? 0);
    expect(opens.length).toBe(2);
    for (const at of opens) {
      const before = src.slice(Math.max(0, at - 2500), at);
      expect(before).toMatch(/checkBackupRows\(keys, account, storageIdentityKey\)/);
    }
    const helper = src.slice(src.indexOf('const checkBackupRows'), src.indexOf('const checkBackupRows') + 900);
    expect(helper).toMatch(/installInboundSyncGuard\(StorageIdb\)/);
    expect(helper).toMatch(/registerInboundVerifier\(/);
  });
});

describe("walletOwnership: the wallet's own keys, from the row's own derivation or record", () => {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const owns = walletOwnership(root);
  const metadata = (WalletPermissionsManager as unknown as { METADATA_ENCRYPTION_PROTOCOL: never })
    .METADATA_ENCRYPTION_PROTOCOL;

  test('change is exactly the P2PKH the toolbox signs it with (sender, else the wallet itself)', async () => {
    const row = {
      vout: 0,
      type: 'P2PKH',
      change: true,
      providedBy: 'storage',
      purpose: 'change',
      derivationPrefix: 'cHJl',
      derivationSuffix: 'c3Vm',
    };
    const pub = kd.derivePublicKey(BRC29, 'cHJl c3Vm', 'self', true);
    const p2pkh = new P2PKH().lock(pub.toAddress()).toHex();
    expect(await owns(row, p2pkh)).toBe(true);
    // The same key behind an inscription is not change; another key is not ours.
    expect(await owns(row, `0063036f7264${p2pkh}`)).toBe(false);
    expect(await owns(row, new P2PKH().lock(new PrivateKey(5).toAddress()).toHex())).toBe(false);
    const sender = new PrivateKey(1).toPublicKey().toString();
    const fromSender = kd.derivePublicKey(BRC29, 'cHJl c3Vm', sender, true);
    expect(await owns({ ...row, senderIdentityKey: sender }, new P2PKH().lock(fromSender.toAddress()).toHex())).toBe(
      true,
    );
  });

  test('a record encrypted by the permissions manager is read and its key checked', async () => {
    const pub = kd.derivePublicKey([0, 'onesat'], 'k9', 'self', true);
    const { ciphertext } = await new ProtoWallet(root).encrypt({
      plaintext: Utils.toArray(JSON.stringify({ protocolID: [0, 'onesat'], keyID: 'k9' }), 'utf8'),
      protocolID: metadata,
      keyID: '1',
    });
    const row = { vout: 0, customInstructions: Utils.toBase64(ciphertext) };
    expect(await owns(row, new P2PKH().lock(pub.toAddress()).toHex())).toBe(true);
    expect(await owns(row, new P2PKH().lock(new PrivateKey(6).toAddress()).toHex())).toBe(false);
  });
});
