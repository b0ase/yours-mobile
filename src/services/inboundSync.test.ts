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
import { outpointsOnDevice, summarizeActive, switchToLocalVerified } from './restoreFromRemote';
import {
  NO_VERIFIER,
  UNCHECKED_PAGE,
  _resetInboundVerifiers,
  installInboundSyncGuard,
  isWalletChange,
  registerInboundVerifier,
  walletOwnership,
  walletRecords,
  HELD_MARK,
  releaseHeldRows,
  isUncheckedPage,
} from './inboundSync';
import { bsv21FieldsFromOutput } from '@1sat/actions';
import { bsv21 } from '../mobile/market/launchpad/tokens';
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
  /** The fake chain: /spent's answer, and whether WhatsOnChain knows a transaction (per txid, else `known`). */
  const chain: {
    answer: SpendState['state'];
    asked: string[];
    known: 'known' | 'unknown' | 'unclear';
    knownFor: Map<string, 'known' | 'unknown' | 'unclear'>;
  } = { answer: 'unclear', asked: [], known: 'known', knownFor: new Map() };
  const verifier = {
    owns: walletOwnership(root),
    spent: async (outpoint: string) => {
      chain.asked.push(outpoint);
      return chain.answer === 'spent'
        ? { state: 'spent' as const, by: 'ff'.repeat(32) }
        : ({ state: chain.answer } as never);
    },
    txKnown: async (txid: string) => chain.knownFor.get(txid) ?? chain.known,
    readRecord: walletRecords(root),
    log: () => undefined,
  };
  const unregister = registerInboundVerifier(phone.getSettings().storageIdentityKey, kd.identityKey, verifier);
  const pull = () => sm.syncFromReader(kd.identityKey, remote as never);
  const row = async (s: StorageIdb, txid: string) => (await s.findOutputs({ partial: { txid, vout: 0 } }))[0];
  /** What a hostile provider answers from now on: its row, rewritten, newer than the phone's. */
  const forge = async (txid: string, patch: Record<string, unknown>) => {
    const r = await row(remote, txid);
    await remote.updateOutput(r.outputId, { ...patch, updated_at: new Date(Date.now() + 3_600_000) } as never);
  };
  return { root, kd, remote, phone, sm, wallet, coin, coin2, token, chain, verifier, pull, row, forge, unregister };
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

  test("an honest restore: the wallet's own coins arrive spendable once the chain confirms them", async () => {
    const d = await phoneWithBackup();
    const fresh = await store(`a3-new-${++n}`);
    d.chain.answer = 'unspent';
    const unregister = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, d.verifier);
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    for (const txid of [d.coin, d.coin2, d.token]) expect((await d.row(fresh, txid)).spendable).toBe(true);
    for (const txid of [d.coin, d.coin2, d.token]) expect(d.chain.asked).toContain(`${txid}.0`);
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
      spent: async (op) => (asked.push(op), { state: 'unspent' }),
      txKnown: async () => 'known',
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
    expect(checked).toBeGreaterThanOrEqual(3); // the copy went through the check: each coin
    expect(asked.length).toBeGreaterThanOrEqual(3); // ...and the chain was asked about each
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

/**
 * Review 16, F2: a row the device has never seen kept whatever token record (amount, id) and token tags the backup sent.
 * A send takes the amount from the record, then from an `amt:` tag (@1sat/actions bsv21FieldsFromOutput), so an
 * inflated amount builds a transfer the chain rejects and burns the tokens. Now the record and the tags must say what
 * the coin's own script says.
 */
describe('F2: a token coin from the backup carries the amount its script says, or is not spendable', () => {
  const TOKEN = `${'ab'.repeat(32)}_0`;

  /** A real BSV-21 transfer of `amt` to a wallet token key, filed the way the wallet files token coins. */
  async function receiveBsv21(w: Wallet, kd: KeyDeriver, amt: bigint, record: Record<string, unknown> | null) {
    const keyID = `tok-${++n}`;
    const pub = kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
    const tx = minedTx(bsv21(TOKEN, amt, pub.toAddress()), 1);
    await w.internalizeAction({
      tx: atomic(tx),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: 'bsv21',
            tags: [`bsv21:${TOKEN}`],
            ...(record ? { customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID, ...record }) } : {}),
          },
        },
      ],
      description: 'Tokens in',
    });
    return tx.id('hex');
  }

  /** A fresh device restored from the backup, read the way a token send reads it. */
  async function restoreAndRead(d: Awaited<ReturnType<typeof phoneWithBackup>>) {
    const fresh = await store(`a3-tok-${++n}`);
    const unregister = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, {
      owns: walletOwnership(d.root),
      spent: async () => ({ state: 'unspent' }),
      txKnown: async () => 'known',
      readRecord: walletRecords(d.root),
    });
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    sm2.setServices(services);
    const w2 = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: sm2, services } as never);
    const listed = await w2.listOutputs({ basket: 'bsv21', includeCustomInstructions: true, includeTags: true });
    unregister();
    return {
      fresh,
      sendable: listed.outputs.map((o) => ({ outpoint: o.outpoint, ...bsv21FieldsFromOutput(o as never) })),
    };
  }

  test('an honest token coin arrives spendable with its amount and its bsv21 tag', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent'; // the provider stand-in is a StorageIdb too: its push is checked like a pull
    const txid = await receiveBsv21(d.wallet, d.kd, 100n, { id: TOKEN, amt: '100', op: 'transfer' });
    await d.sm.updateBackups();
    const { sendable } = await restoreAndRead(d);
    const mine = sendable.find((o) => o.outpoint.startsWith(txid));
    expect(mine?.amt).toBe('100');
    expect(mine?.tokenId).toBe(TOKEN);
  });

  test('an inflated amount in the record: the coin arrives not spendable, so no send can use it', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent'; // the provider stand-in is a StorageIdb too: its push is checked like a pull
    const txid = await receiveBsv21(d.wallet, d.kd, 100n, { id: TOKEN, amt: '100', op: 'transfer' });
    await d.sm.updateBackups();
    const r = await d.row(d.remote, txid);
    await d.forge(txid, {
      customInstructions: JSON.stringify({ ...JSON.parse(r.customInstructions!), amt: '1000000' }),
    });
    const { fresh, sendable } = await restoreAndRead(d);
    expect(sendable.find((o) => o.outpoint.startsWith(txid))).toBeUndefined();
    expect((await d.row(fresh, txid)).spendable).toBe(false);
  });

  test('a forged amt: tag on a coin whose record has no amount arrives deleted', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent'; // the provider stand-in is a StorageIdb too: its push is checked like a pull
    const txid = await receiveBsv21(d.wallet, d.kd, 100n, { id: TOKEN, op: 'transfer' });
    await d.sm.updateBackups();
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const out = await d.row(d.remote, txid);
    const tag = await d.remote.findOrInsertOutputTag(userId, 'amt:999999');
    const later = new Date(Date.now() + 3_600_000);
    await d.remote.insertOutputTagMap({
      outputId: out.outputId,
      outputTagId: tag.outputTagId,
      isDeleted: false,
      created_at: later,
      updated_at: later,
    } as never);
    const { sendable } = await restoreAndRead(d);
    const mine = sendable.find((o) => o.outpoint.startsWith(txid));
    expect(mine?.amt).not.toBe('999999');
  });

  test('a token tag that matches the script (an honest amt:) still arrives', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent'; // the provider stand-in is a StorageIdb too: its push is checked like a pull
    const txid = await receiveBsv21(d.wallet, d.kd, 100n, { id: TOKEN, op: 'transfer' });
    await d.sm.updateBackups();
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const out = await d.row(d.remote, txid);
    const tag = await d.remote.findOrInsertOutputTag(userId, 'amt:100');
    const later = new Date(Date.now() + 3_600_000);
    await d.remote.insertOutputTagMap({
      outputId: out.outputId,
      outputTagId: tag.outputTagId,
      isDeleted: false,
      created_at: later,
      updated_at: later,
    } as never);
    const { sendable } = await restoreAndRead(d);
    expect(sendable.find((o) => o.outpoint.startsWith(txid))?.amt).toBe('100');
  });
});

/**
 * Review 16, F4: ways around "arrives not spendable" and the chain check.
 *  (a) a row planted not spendable went in unchecked, then a newer copy flipped it spendable on WhatsOnChain's word;
 *  (b) WhatsOnChain answers /spent with 404 for an outpoint it has never seen, which counted as "unspent";
 *  (c) the backup could rewrite a failed transaction's status, defeating the failed-transaction check;
 *  (d) the wallet's own coins were never asked of the chain, so a restore took back spent change as spendable.
 */
describe('F4: the chain check holds against a two-step plant, a 404, a status rewrite and spent change', () => {
  type D = Awaited<ReturnType<typeof phoneWithBackup>>;
  /** The provider plants a transaction and an output, filed like the wallet's change unless `other`. */
  async function plant(d: D, opts: { spendable: boolean; other?: boolean }) {
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
      ...(opts.other
        ? {
            change: false,
            type: 'custom',
            providedBy: 'you',
            purpose: '',
            derivationPrefix: undefined,
            derivationSuffix: undefined,
          }
        : { derivationPrefix: Utils.toBase64(Random(8)), derivationSuffix: Utils.toBase64(Random(8)) }),
      spendable: opts.spendable,
      spentBy: undefined,
      created_at: later,
      updated_at: later,
    } as never);
    return ptxid;
  }

  test('(a) a row that arrived not spendable is not made spendable by a newer copy and a WoC answer', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const ptxid = await plant(d, { spendable: false });
    await d.pull();
    expect((await d.row(d.phone, ptxid)).spendable).toBe(false);
    await d.forge(ptxid, { spendable: true });
    await d.pull();
    expect((await d.row(d.phone, ptxid)).spendable).toBe(false);
  });

  test('(b) a 404 from WhatsOnChain is not "unspent": a coin of a transaction the chain does not know is held', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent'; // /spent: 404
    const ptxid = await plant(d, { spendable: true, other: true });
    d.chain.knownFor.set(ptxid, 'unknown'); // /tx/hash: 404
    await d.pull();
    const got = await d.row(d.phone, ptxid);
    expect(got.spendable).toBe(false);
    expect((got as { spendingDescription?: string }).spendingDescription).toBe(HELD_MARK);
  });

  test('(c) the backup cannot rewrite a failed transaction to completed and then bring its coin back', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateTransaction(mine.transactionId, { status: 'failed' } as never);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const theirs = (await d.remote.findTransactions({ partial: { userId, txid: d.coin } }))[0];
    await d.remote.updateTransaction(theirs.transactionId, {
      status: 'completed',
      updated_at: new Date(Date.now() + 3_600_000),
    } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin, 'unknown'); // never on the network
    await d.pull();
    const status = async () =>
      (await d.phone.findTransactions({ partial: { transactionId: mine.transactionId }, noRawTx: true }))[0].status;
    expect(await status()).toBe('failed');
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
    await d.forge(d.coin, { spendable: true, spendingDescription: 'again' });
    await d.pull();
    expect(await status()).toBe('failed');
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
  });

  test("(d) a fresh restore asks the chain even about the wallet's own coins: spent change stays not spendable", async () => {
    const d = await phoneWithBackup();
    const fresh = await store(`a3-f4d-${++n}`);
    const unregister = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, {
      ...d.verifier,
      spent: async (op: string) =>
        op === `${d.coin}.0` ? { state: 'spent' as const, by: 'ee'.repeat(32) } : { state: 'unspent' as const },
    });
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    expect((await d.row(fresh, d.coin)).spendable).toBe(false);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    unregister();
  });

  test('a coin held because WhatsOnChain did not know its transaction yet is released once it does (no stranding)', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin, 'unknown');
    const fresh = await store(`a3-hold-${++n}`);
    const unregister = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, d.verifier);
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    expect((await d.row(fresh, d.coin)).spendable).toBe(false);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    // Still unknown: nothing changes.
    expect(await releaseHeldRows(fresh as never, d.kd.identityKey, d.verifier)).toEqual({ released: 0, spent: 0 });
    d.chain.knownFor.set(d.coin, 'known');
    expect(await releaseHeldRows(fresh as never, d.kd.identityKey, d.verifier)).toEqual({ released: 1, spent: 0 });
    const got = await d.row(fresh, d.coin);
    expect(got.spendable).toBe(true);
    expect((got as { spendingDescription?: string | null }).spendingDescription ?? null).toBeNull();
    unregister();
  });
});

/**
 * Review 16, F5: the A3 check must not strand an honest restore. The restore switch compared the device's spendable
 * change with the backup's and rolled back to the backup when it was short, and the backup then refuses every payment;
 * a coin the check held back made the device "short". And a backup-file import that failed because WhatsOnChain was
 * down counted toward the 3 tries after which the parked backup is deleted.
 */
describe('F5: held-back coins do not strand a restore, and a WhatsOnChain outage never deletes a parked backup', () => {
  test('a restore that holds back one coin (the chain says it is spent) still moves the account to the device', async () => {
    const d = await phoneWithBackup();
    const name = `a3-f5-${++n}`;
    const local = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    (local as unknown as { dbName: string }).dbName = name;
    await local.migrate(name, `sik-${name}`);
    const unregister = registerInboundVerifier(`sik-${name}`, d.kd.identityKey, {
      ...d.verifier,
      spent: async (op: string) =>
        op === `${d.coin}.0` ? { state: 'spent' as const, by: 'ee'.repeat(32) } : { state: 'unspent' as const },
      txKnown: async () => 'known',
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
      deviceHolds: outpointsOnDevice(core.storage as never), // as background.ts restoreDeps wires it
    });
    expect(r.ok).toBe(true);
    expect((await d.row(local, d.coin)).spendable).toBe(false);
    expect((await d.row(local, d.coin2)).spendable).toBe(true);
    unregister();
  });

  test('coins held back count as present, not missing; a device genuinely short still stays on the backup', async () => {
    const remote = { outputs: 3, spendableSats: 300, actions: 3, coins: ['a.0', 'b.0', 'c.0'] };
    const short = { outputs: 2, spendableSats: 200, actions: 3, coins: ['a.0', 'b.0'] };
    const run = async (onDevice: string[]) => {
      let active: string | undefined = 'r';
      return switchToLocalVerified({
        remoteUrl: 'r',
        activeRemoteUrl: () => active,
        setActiveStorage: async (t) => {
          active = t === 'local' ? undefined : t;
        },
        summarize: async () => (active ? remote : short),
        pullRemote: async () => undefined,
        deviceHolds: async (ops) => new Set(ops.filter((o) => onDevice.includes(o))),
      });
    };
    expect((await run(['a.0', 'b.0', 'c.0'])).ok).toBe(true); // c.0 is on the device, held back
    expect((await run(['a.0', 'b.0'])).ok).toBe(false); // c.0 never arrived
  });

  test('an import refused because WhatsOnChain could not be asked is not counted toward deleting the parked backup', () => {
    expect(isUncheckedPage(new Error(UNCHECKED_PAGE))).toBe(true);
    expect(isUncheckedPage(new Error('backup file is corrupt'))).toBe(false);
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toMatch(
      /const attempts = isUncheckedPage\(error\) \? 0 : await WalletBackupService\.notePendingRestoreAttempt\(currentIdentityKey\);/,
    );
    expect(bg).toMatch(/deviceHolds: outpointsOnDevice\(ctx\.storage as never\)/);
  });
});

describe('honest multi-device sync still works after the review fixes', () => {
  test("the owner's other device receives a coin and spends one; this device pulls both changes", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    // Device B: its own store, the same backup, the same account.
    const other = await store(`a3-b-${++n}`);
    const smB = new WalletStorageManager(d.kd.identityKey, other, [d.remote]);
    await smB.makeAvailable();
    await smB.setActive(other.getSettings().storageIdentityKey);
    smB.setServices(services);
    await smB.syncFromReader(d.kd.identityKey, d.remote as never);
    const walletB = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: smB, services } as never);
    const received = await receive(walletB, d.kd, 33_000);
    const spentOnB = await d.row(other, d.coin2);
    await other.updateOutput(spentOnB.outputId, { spendable: false } as never);
    await smB.updateBackups();
    // This device (A) pulls on open.
    await d.pull();
    expect((await d.row(d.phone, received)).spendable).toBe(true); // new coin, the chain confirms it
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(false); // spent elsewhere: taken as is
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true); // untouched
    expect(d.chain.asked).toContain(`${received}.0`);
  });
});

/** Review 16b, T4 (R1): the F5 credit lived in memory, so a restore interrupted and retried after a restart stayed stuck. */
describe('R1: an interrupted restore, retried after a restart, still moves the account to the device', () => {
  test('T4: attempt 1 is cut off after the copy; after a restart, attempt 2 completes', async () => {
    const d = await phoneWithBackup();
    const name = `r16b-f5-${++n}`;
    const local = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    (local as unknown as { dbName: string }).dbName = name;
    await local.migrate(name, `sik-${name}`);
    const verifier = {
      owns: walletOwnership(d.root),
      readRecord: walletRecords(d.root),
      // The backup is stale about one coin: it says spendable, the chain says spent.
      spent: async (op: string) =>
        op === `${d.coin}.0` ? { state: 'spent' as const, by: 'ee'.repeat(32) } : { state: 'unspent' as const },
      txKnown: async () => 'known' as const,
    };
    registerInboundVerifier(`sik-${name}`, d.kd.identityKey, verifier);
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
    const deps = (interrupt: boolean) => {
      let calls = 0;
      return {
        remoteUrl,
        activeRemoteUrl: () => core.storage.getStores().find((s) => s.isActive && !s.isConflicting)?.endpointURL,
        setActiveStorage: core.setActiveStorage,
        summarize: async () => {
          calls++;
          if (interrupt && calls === 2) throw new Error('worker interrupted after the copy');
          return summarizeActive(core.wallet as never);
        },
        pullRemote: async () => {
          if (interrupt) throw new Error('network dropped');
          await core.storage.syncFromReader((await core.storage.getAuth()).identityKey, d.remote as never);
        },
        deviceHolds: outpointsOnDevice(core.storage as never),
      };
    };
    const r1 = await switchToLocalVerified(deps(true));
    expect(r1.ok).toBe(false);
    // A restart: nothing in memory survives; initWallet sets the check up again.
    _resetInboundVerifiers();
    registerInboundVerifier(`sik-${name}`, d.kd.identityKey, verifier);
    const r2 = await switchToLocalVerified(deps(false));
    expect(r2.ok).toBe(true);
    expect((await d.row(local, d.coin)).spendable).toBe(false); // the spent coin stays held back
    expect((await d.row(local, d.coin2)).spendable).toBe(true);
  });
});
