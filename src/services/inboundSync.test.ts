/**
 * b-Aware A3 (0xzero, 25 Oct 2026): a hostile or compromised remote storage provider could forge spendable wallet
 * state on this device, because the toolbox's sync merge took its rows as sent.
 *
 * Local only: fake-indexeddb, the real toolbox (StorageIdb, WalletStorageManager, Wallet), a second StorageIdb
 * standing in for wallet.1sat.app, random keys, and a fake chain answer. The provider's rows are rewritten the way a
 * hostile server would answer getSyncChunk (directly in its tables), then this device pulls with syncFromReader, the
 * call device sync, F-C and the restore switch all use, and works through its admission list (admitPending) as device
 * sync does after every pull. The stand-in merges what the phone pushes unchecked: in the app it is a StorageClient.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
  admitPending,
  pendingAdmissions,
  _mergeUnchecked,
  isUncheckedPage,
  PROMPT_RETRY_MS,
  type InboundVerifier,
} from './inboundSync';
import { bsv21FieldsFromOutput } from '@1sat/actions';
import { bsv21 } from '../mobile/market/launchpad/tokens';
import { ASSET_ID_MISMATCH, assetIdIsOnly, guardAssetIdLoads } from './assetIdCheck';
import { loadBasketOutput } from '@1sat/actions';
import { eitherChainSource } from './chainSources';
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

/** The harness's token: a BSV-21 id its coins carry in their scripts, as the wallet's token coins do. */
const HARNESS_TOKEN = `${'99'.repeat(32)}_0`;
/** A 1-sat BSV-21 coin at a wallet key, its record naming that key, the token and the amount its script carries. */
async function receiveToken(w: Wallet, kd: KeyDeriver) {
  const keyID = `tok-${++n}`;
  const pub = kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
  const tx = minedTx(bsv21(HARNESS_TOKEN, 100n, pub.toAddress()), 1);
  await w.internalizeAction({
    tx: atomic(tx),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: 'tokens-test',
          customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID, id: HARNESS_TOKEN, amt: '100' }),
        },
      },
    ],
    description: 'Token in',
  });
  return tx.id('hex');
}

/** The test clock admitPending runs on: real time, moved forward by tick() to reach a waiting entry's next try. */
const clock = { skew: 0 };
const now = () => Date.now() + clock.skew;
const tick = (ms: number) => void (clock.skew += ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
/** What device sync does after each pull, on the test clock. */
const admit = (s: StorageIdb, identityKey: string, v: InboundVerifier) =>
  admitPending(s as never, identityKey, v, { now });
/** What is waiting on this device's admission list, as "txid.vout" or "tx:txid". */
const waiting = async (s: StorageIdb, identityKey: string) =>
  (await pendingAdmissions(s as never, identityKey)).map((e) =>
    e.kind === 'coin' ? `${e.txid}.${e.vout}` : `tx:${e.txid}`,
  );

/** This phone (device store active) and its backup provider, two coins and a token pushed to the backup. */
async function phoneWithBackup() {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const tag = ++n;
  const remote = await store(`a3-remote-${tag}`);
  _mergeUnchecked(remote); // the provider: in the app a StorageClient, never this device's guarded store
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
  /** The merge alone (no admission yet). */
  const merge = () => sm.syncFromReader(kd.identityKey, remote as never);
  /** What device sync does on open: the merge, then the admission list. */
  const pull = async () => {
    await merge();
    return admit(phone, kd.identityKey, verifier);
  };
  const row = async (s: StorageIdb, txid: string) => (await s.findOutputs({ partial: { txid, vout: 0 } }))[0];
  /** What a hostile provider answers from now on: its row, rewritten, newer than the phone's. */
  const forge = async (txid: string, patch: Record<string, unknown>) => {
    const r = await row(remote, txid);
    await remote.updateOutput(r.outputId, { ...patch, updated_at: new Date(Date.now() + 3_600_000) } as never);
  };
  /** A fresh device restored from the backup: the toolbox copy, then the admission list. */
  const restore = async (v: InboundVerifier = verifier) => {
    const fresh = await store(`a3-fresh-${++n}`);
    const off = registerInboundVerifier(fresh.getSettings().storageIdentityKey, kd.identityKey, v);
    const sm2 = new WalletStorageManager(kd.identityKey, fresh, [remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    sm2.setServices(services);
    await sm2.syncFromReader(kd.identityKey, remote as never);
    const admitted = await admit(fresh, kd.identityKey, v);
    return { fresh, sm2, admitted, unregister: off };
  };
  return {
    root,
    kd,
    remote,
    phone,
    sm,
    wallet,
    coin,
    coin2,
    token,
    chain,
    verifier,
    merge,
    pull,
    restore,
    row,
    forge,
    unregister,
  };
}

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installInboundSyncGuard(StorageIdb);
});
beforeEach(() => {
  clock.skew = 0;
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
    d.chain.knownFor.set(d.coin, 'unknown'); // ...and /tx/hash: it never had it
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
    tick(HOUR);
    await admit(d.phone, d.kd.identityKey, d.verifier);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
  });

  test('chain unreachable: that coin is held (not spendable) and released once the chain answers', async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'unclear';
    await d.pull(); // no longer refuses the page (review 16b, R4)
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
    expect(await waiting(d.phone, d.kd.identityKey)).toEqual([`${d.coin}.0`]);
    d.chain.answer = 'unspent';
    tick(2 * MIN);
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).admitted).toBe(1);
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
    d.chain.answer = 'unspent';
    const { fresh, unregister } = await d.restore();
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
    const checking: InboundVerifier = {
      owns: async (row, script) => (checked++, owns(row, script)),
      spent: async (op) => (asked.push(op), { state: 'unspent' }),
      txKnown: async () => 'known',
    };
    const unregister = registerInboundVerifier(`sik-${name}`, d.kd.identityKey, checking);
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
      admit: () => admit(local, d.kd.identityKey, checking), // as background.ts restoreDeps wires it (C6)
    });
    expect(r.ok).toBe(true);
    const spendable = (await local.findOutputs({ partial: {} })).filter((o) => o.spendable);
    expect(spendable.reduce((s, o) => s + o.satoshis, 0)).toBe(50_000 + 70_000 + 1);
    expect(checked).toBeGreaterThanOrEqual(2); // the copy went through the check: each change coin's key
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
    const { fresh, sm2, unregister } = await d.restore({
      owns: walletOwnership(d.root),
      spent: async () => ({ state: 'unspent' }),
      txKnown: async () => 'known',
      readRecord: walletRecords(d.root),
    });
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
    expect(await waiting(d.phone, d.kd.identityKey)).toEqual([`${ptxid}.0`]); // asked again later
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
    const { fresh, unregister } = await d.restore({
      ...d.verifier,
      spent: async (op: string) =>
        op === `${d.coin}.0` ? { state: 'spent' as const, by: 'ee'.repeat(32) } : { state: 'unspent' as const },
    });
    expect((await d.row(fresh, d.coin)).spendable).toBe(false);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    unregister();
  });

  test('a coin held because WhatsOnChain did not know its transaction yet is released once it does (no stranding)', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin, 'unknown');
    const { fresh, unregister } = await d.restore();
    expect((await d.row(fresh, d.coin)).spendable).toBe(false);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    // Still unknown: nothing changes.
    tick(2 * MIN);
    expect((await admit(fresh, d.kd.identityKey, d.verifier)).admitted).toBe(0);
    d.chain.knownFor.set(d.coin, 'known');
    tick(5 * MIN);
    expect((await admit(fresh, d.kd.identityKey, d.verifier)).admitted).toBe(1);
    expect((await d.row(fresh, d.coin)).spendable).toBe(true);
    expect(await waiting(fresh, d.kd.identityKey)).toEqual([]);
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
    const f5: InboundVerifier = {
      ...d.verifier,
      spent: async (op: string) =>
        op === `${d.coin}.0` ? { state: 'spent' as const, by: 'ee'.repeat(32) } : { state: 'unspent' as const },
      txKnown: async () => 'known',
    };
    const unregister = registerInboundVerifier(`sik-${name}`, d.kd.identityKey, f5);
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
      admit: () => admit(local, d.kd.identityKey, f5),
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
    expect(bg).toMatch(/admit: \(\) => ctx\.admitBackupRows\(\)/);
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
        admit: () => admit(local, d.kd.identityKey, verifier),
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

/**
 * Review 16b, T2 (R2): sends and listings load an NFT by its tracking id (`id:` tag, limit 1). A backup could link
 * the user's valuable ordinal Y to the id of a cheap ordinal X, so "send X" spent Y.
 */
describe('R2: one tracking id, one asset', () => {
  /** A 1-sat ordinal at a wallet key, in basket '1sat', tagged id:<id> (as stampManagedOutputIds does). */
  async function receiveOrdinal(w: Wallet, kd: KeyDeriver, id: string) {
    const keyID = `ord-${++n}`;
    const pub = kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
    const tx = minedTx(new P2PKH().lock(pub.toAddress()), 1);
    await w.internalizeAction({
      tx: atomic(tx),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: '1sat',
            customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID }),
            tags: [`id:${id}`],
          },
        },
      ],
      description: 'Ordinal in',
    });
    return tx.id('hex');
  }
  const loadById = (d: Awaited<ReturnType<typeof phoneWithBackup>>, id: string) =>
    d.wallet.listOutputs({
      basket: '1sat',
      tags: [`id:${id}`],
      tagQueryMode: 'all',
      includeTags: true,
      limit: 1,
    } as never);

  test("T2: the backup links Y to X's id; loading X still returns X, and only X", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const yTx = await receiveOrdinal(d.wallet, d.kd, 'yyyyyyyyyyyy');
    const xTx = await receiveOrdinal(d.wallet, d.kd, 'xxxxxxxxxxxx');
    await d.sm.updateBackups();
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const ry = await d.row(d.remote, yTx);
    const xTag = (await d.remote.findOutputTags({ partial: { userId, tag: 'id:xxxxxxxxxxxx' } }))[0];
    const later = new Date(Date.now() + 3_600_000);
    await d.remote.insertOutputTagMap({
      outputId: ry.outputId,
      outputTagId: xTag.outputTagId,
      isDeleted: false,
      created_at: later,
      updated_at: later,
    } as never);
    await d.pull();
    const res = await loadById(d, 'xxxxxxxxxxxx');
    expect(res.totalOutputs).toBe(1);
    expect(res.outputs[0]?.outpoint).toBe(`${xTx}.0`);
    expect(await assetIdIsOnly(d.wallet as never, 'xxxxxxxxxxxx', `${xTx}.0`)).toBe(true);
  });

  test('a page giving one new id to two outputs: only the first takes it', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const aTx = await receiveOrdinal(d.wallet, d.kd, 'aaaaaaaaaaaa');
    const bTx = await receiveOrdinal(d.wallet, d.kd, 'bbbbbbbbbbbb');
    await d.sm.updateBackups();
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    const rb = await d.row(d.remote, bTx);
    const aTag = (await d.remote.findOutputTags({ partial: { userId, tag: 'id:aaaaaaaaaaaa' } }))[0];
    const later = new Date(Date.now() + 3_600_000);
    await d.remote.insertOutputTagMap({
      outputId: rb.outputId,
      outputTagId: aTag.outputTagId,
      isDeleted: false,
      created_at: later,
      updated_at: later,
    } as never);
    const { sm2, unregister } = await d.restore();
    const w2 = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: sm2, services } as never);
    const a = await w2.listOutputs({
      basket: '1sat',
      tags: ['id:aaaaaaaaaaaa'],
      tagQueryMode: 'all',
      limit: 5,
    } as never);
    expect(a.totalOutputs).toBe(1);
    expect(a.outputs[0].outpoint).toBe(`${aTx}.0`);
    const b = await w2.listOutputs({
      basket: '1sat',
      tags: ['id:bbbbbbbbbbbb'],
      tagQueryMode: 'all',
      limit: 5,
    } as never);
    expect(b.outputs.map((o) => o.outpoint)).toEqual([`${bTx}.0`]); // honest ids still arrive
    unregister();
  });

  test('assetIdIsOnly: refuses an id that loads another outpoint, or more than one', async () => {
    const answer = (outpoints: string[]) => ({
      listOutputs: async () => ({
        outputs: outpoints.map((outpoint) => ({ outpoint })),
        totalOutputs: outpoints.length,
      }),
    });
    const X = `${'ab'.repeat(32)}.0`;
    const Y = `${'cd'.repeat(32)}.0`;
    expect(await assetIdIsOnly(answer([X]), 'x', X)).toBe(true);
    expect(await assetIdIsOnly(answer([X]), 'x', `${'ab'.repeat(32)}_0`)).toBe(true);
    expect(await assetIdIsOnly(answer([Y]), 'x', X)).toBe(false);
    expect(await assetIdIsOnly(answer([X, Y]), 'x', X)).toBe(false);
    expect(await assetIdIsOnly(answer([]), 'x', X)).toBe(false);
  });
});

/**
 * Review 16b, T1 (R3): a backup moving a completed transaction to failed (or adding an 'invalid' proof request) made the
 * device's own monitor (reviewStatus) free the coins it spent, which are spent on chain, and hide the coins it made.
 */
describe('R3: a backup cannot fail a transaction the device knows', () => {
  type D = Awaited<ReturnType<typeof phoneWithBackup>>;
  const deviceTx = async (d: D, txid: string) => {
    const { userId } = (await d.phone.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    return (await d.phone.findTransactions({ partial: { userId, txid }, noRawTx: true }))[0];
  };
  const remoteTx = async (d: D, txid: string) => {
    const { userId } = (await d.remote.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
    return (await d.remote.findTransactions({ partial: { userId, txid }, noRawTx: true }))[0];
  };

  test('T1: completed -> failed from the backup is refused; reviewStatus then changes nothing', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const T = await deviceTx(d, d.coin);
    expect(T.status).toBe('completed');
    // T spent coin2 on this device (as a payment would).
    const c2 = await d.row(d.phone, d.coin2);
    await d.phone.updateOutput(c2.outputId, { spendable: false, spentBy: T.transactionId } as never);
    const RT = await remoteTx(d, d.coin);
    await d.remote.updateTransaction(RT.transactionId, {
      status: 'failed',
      provenTxId: undefined,
      updated_at: new Date(Date.now() + 3_600_000),
    } as never);
    await d.pull();
    expect((await deviceTx(d, d.coin)).status).toBe('completed');
    await d.phone.reviewStatus({ agedLimit: new Date() } as never);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(false); // still spent
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true); // the real coin still there
  });

  test("an 'invalid' proof request from the backup for a transaction the device holds arrives to be checked again", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const later = new Date(Date.now() + 3_600_000);
    await d.remote.insertProvenTxReq({
      provenTxReqId: 0,
      created_at: later,
      updated_at: later,
      txid: d.coin,
      status: 'invalid',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx: [1, 2, 3],
    } as never);
    await d.pull();
    const reqs = await d.phone.findProvenTxReqs({ partial: { txid: d.coin } });
    expect(reqs.every((r) => r.status !== 'invalid')).toBe(true);
    await d.phone.reviewStatus({ agedLimit: new Date() } as never);
    expect((await deviceTx(d, d.coin)).status).toBe('completed');
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true);
  });

  test('a payment another device saw refused (no proof, the chain does not know it) still arrives as failed', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const T = await deviceTx(d, d.coin2);
    const pendingTxid = Utils.toHex(Random(32));
    await d.phone.insertTransaction({
      ...T,
      transactionId: 0,
      txid: pendingTxid,
      reference: Utils.toBase64(Random(12)),
      status: 'unproven',
      provenTxId: undefined,
      isOutgoing: true,
      created_at: new Date(),
      updated_at: new Date(),
    } as never);
    await d.sm.updateBackups();
    const RT = await remoteTx(d, pendingTxid);
    await d.remote.updateTransaction(RT.transactionId, {
      status: 'failed',
      updated_at: new Date(Date.now() + 3_600_000),
    } as never);
    d.chain.knownFor.set(pendingTxid, 'known'); // first: the chain has it, so it is not failed
    await d.pull();
    expect((await deviceTx(d, pendingTxid)).status).toBe('unproven');
    await d.remote.updateTransaction(RT.transactionId, { updated_at: new Date(Date.now() + 7_200_000) } as never);
    d.chain.knownFor.set(pendingTxid, 'unknown'); // the chain never had it: failed is right
    await d.pull();
    expect((await deviceTx(d, pendingTxid)).status).toBe('failed');
  });
});

/**
 * Review 16b, R4: one WhatsOnChain hiccup threw away the whole page, with any spent-elsewhere updates on it, and a
 * restore under throttling never finished. Now only the coin in question is held, and it is asked about again later.
 */
describe('R4: a WhatsOnChain hiccup holds one coin, never the page', () => {
  test("another device's spend still lands while one coin waits for the chain", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const other = await store(`r4-b-${++n}`);
    const smB = new WalletStorageManager(d.kd.identityKey, other, [d.remote]);
    await smB.makeAvailable();
    await smB.setActive(other.getSettings().storageIdentityKey);
    smB.setServices(services);
    await smB.syncFromReader(d.kd.identityKey, d.remote as never);
    const walletB = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: smB, services } as never);
    const received = await receive(walletB, d.kd, 33_000); // a new coin: the chain will be asked
    const spentOnB = await d.row(other, d.coin2);
    await other.updateOutput(spentOnB.outputId, { spendable: false } as never); // spent on device B
    await smB.updateBackups();
    d.chain.answer = 'unclear'; // WhatsOnChain throttled
    await d.pull();
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(false); // the spend landed
    expect((await d.row(d.phone, received)).spendable).toBe(false); // held, not dropped
    d.chain.answer = 'unspent';
    tick(2 * MIN);
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).admitted).toBe(1);
    expect((await d.row(d.phone, received)).spendable).toBe(true);
  });

  test('a restore with WhatsOnChain down the whole time finishes, every coin held, then released', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unclear';
    const { fresh, unregister } = await d.restore(); // completes
    for (const txid of [d.coin, d.coin2]) expect((await d.row(fresh, txid)).spendable).toBe(false);
    d.chain.answer = 'unspent';
    tick(2 * MIN);
    expect((await admit(fresh, d.kd.identityKey, d.verifier)).admitted).toBeGreaterThanOrEqual(2);
    for (const txid of [d.coin, d.coin2]) expect((await d.row(fresh, txid)).spendable).toBe(true);
    unregister();
  });
});

/**
 * Review 16b, T3 (R5): a coin this device is spending in a transaction not yet broadcast (a pot's pre-signed payment,
 * a BRC-177 anchor, a Store outbox entry) was revived by a newer backup row: the chain hasn't seen the spend, so it
 * says unspent. The wallet could then pick the coin again and the pre-signed payment would fail.
 */
describe("R5: a coin the device is spending in a payment not yet on the network isn't revived", () => {
  for (const status of ['nosend', 'unsigned', 'unprocessed', 'sending', 'unproven', 'nonfinal', 'unfail'])
    test(`T3: spent by this device's ${status} transaction: stays spent here`, async () => {
      const d = await phoneWithBackup();
      const { userId } = (await d.phone.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
      const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin2 }, noRawTx: true }))[0];
      const pending = await d.phone.insertTransaction({
        ...T,
        transactionId: 0,
        txid: Utils.toHex(Random(32)),
        reference: Utils.toBase64(Random(12)),
        status,
        provenTxId: undefined,
        isOutgoing: true,
        created_at: new Date(),
        updated_at: new Date(),
      } as never);
      const c = await d.row(d.phone, d.coin);
      await d.phone.updateOutput(c.outputId, { spendable: false, spentBy: pending } as never);
      await d.forge(d.coin, { spendable: true, spentBy: undefined });
      d.chain.answer = 'unspent'; // the chain hasn't seen this device's spend yet
      await d.pull();
      const got = await d.row(d.phone, d.coin);
      expect(got.spendable).toBe(false);
      expect(got.spentBy).toBe(pending);
    });
});

/**
 * Review 16c: the third review's scratch repros (H1-H5), now asserting the fixed behaviour, and the redesign's own
 * guarantees: a merge only lowers what is spendable, and a coin becomes spendable only through admitPending.
 */
describe('16c: a merge never makes a coin spendable; only the admission list does, after every check', () => {
  type D = Awaited<ReturnType<typeof phoneWithBackup>>;
  /** What b47101bc marked held coins with, in a column every backup writes. */
  const OLD_HELD_MARK = 'bwx: waiting for the chain to show this coin';
  const TOKEN = `${'cd'.repeat(32)}_0`;
  let clockAt = 1;
  const later = () => new Date(Date.now() + HOUR * clockAt++);
  const userOf = async (s: StorageIdb, d: D) =>
    (await s.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0].userId;
  async function receiveBsv21(w: Wallet, kd: KeyDeriver, amt: bigint) {
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
            customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID, id: TOKEN, amt: String(amt) }),
          },
        },
      ],
      description: 'Tokens in',
    });
    return tx.id('hex');
  }
  /** The token coins a send would read on this store. */
  const tokenSend = async (d: D, sm2: WalletStorageManager) => {
    const w2 = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: sm2, services } as never);
    const listed = await w2.listOutputs({ basket: 'bsv21', includeCustomInstructions: true, includeTags: true });
    return listed.outputs.map((o) => ({ outpoint: o.outpoint, ...bsv21FieldsFromOutput(o as never) }));
  };
  /** A transaction of the backup's own (a copy of a real one's row), with this status and raw bytes. */
  const backupTx = async (d: D, status: string, raw?: Transaction) => {
    const ru = await userOf(d.remote, d);
    const RT = (await d.remote.findTransactions({ partial: { userId: ru, txid: d.coin2 }, noRawTx: true }))[0];
    const t = later();
    const txid = raw ? raw.id('hex') : Utils.toHex(Random(32));
    const id = await d.remote.insertTransaction({
      ...RT,
      transactionId: 0,
      txid,
      reference: Utils.toBase64(Random(12)),
      status,
      provenTxId: undefined,
      rawTx: raw ? raw.toBinary() : undefined,
      created_at: t,
      updated_at: t,
    } as never);
    return { id, txid };
  };
  /** A payment of this device's own, not yet on the network, spending `coin` (a pot's pre-signed payment). */
  const unsentSpend = async (d: D, coin: string, withReq = false) => {
    const userId = await userOf(d.phone, d);
    const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin2 }, noRawTx: true }))[0];
    const txid = Utils.toHex(Random(32));
    const id = await d.phone.insertTransaction({
      ...T,
      transactionId: 0,
      txid,
      reference: Utils.toBase64(Random(12)),
      status: 'nosend',
      provenTxId: undefined,
      isOutgoing: true,
      created_at: new Date(),
      updated_at: new Date(),
    } as never);
    if (withReq) {
      const at = new Date();
      await d.phone.insertProvenTxReq({
        provenTxReqId: 0,
        created_at: at,
        updated_at: at,
        txid,
        status: 'nosend',
        attempts: 0,
        notified: false,
        history: '{}',
        notify: '{}',
        rawTx: [1, 2, 3],
      } as never);
    }
    const c = await d.row(d.phone, coin);
    await d.phone.updateOutput(c.outputId, { spendable: false, spentBy: id, updated_at: new Date() } as never);
    return { id, txid };
  };

  for (const viaHeld of [false, true])
    test(`C1/H1${viaHeld ? '' : ' control'}: a real token coin, record amount inflated, sent ${viaHeld ? 'not spendable with the old held mark' : 'spendable'}: never spendable`, async () => {
      const d = await phoneWithBackup();
      d.chain.answer = 'unspent';
      const tok = await receiveBsv21(d.wallet, d.kd, 100n);
      await d.sm.updateBackups();
      const r = await d.row(d.remote, tok);
      await d.remote.updateOutput(r.outputId, {
        customInstructions: JSON.stringify({ ...JSON.parse(r.customInstructions!), amt: '1000000' }),
        spendable: !viaHeld,
        ...(viaHeld ? { spendingDescription: OLD_HELD_MARK } : {}),
        updated_at: later(),
      } as never);
      const { fresh, sm2, unregister } = await d.restore();
      for (let i = 0; i < 3; i++) {
        tick(7 * HOUR);
        await admit(fresh, d.kd.identityKey, d.verifier); // any number of later runs
      }
      expect((await tokenSend(d, sm2)).find((o) => o.outpoint.startsWith(tok))).toBeUndefined();
      expect((await d.row(fresh, tok)).spendable).toBe(false);
      unregister();
    });

  test('C1/H1c: planted "change" paying a stranger, sent not spendable with the old held mark: never spendable', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const planted = minedTx(new P2PKH().lock(PrivateKey.fromRandom().toAddress()), 90_000);
    const { id: tid } = await backupTx(d, 'completed', planted);
    const r = await d.row(d.remote, d.coin2);
    const t = later();
    await d.remote.insertOutput({
      ...r,
      outputId: 0,
      transactionId: tid,
      txid: planted.id('hex'),
      vout: 0,
      satoshis: 90_000,
      lockingScript: planted.outputs[0].lockingScript.toBinary(),
      spendable: false,
      spentBy: undefined,
      spendingDescription: OLD_HELD_MARK,
      created_at: t,
      updated_at: t,
    } as never);
    expect(isWalletChange(await d.row(d.remote, planted.id('hex')))).toBe(true);
    await d.pull();
    // ...and the two-step plant on top: a newer copy, spendable, with the chain saying unspent.
    const rp = await d.row(d.remote, planted.id('hex'));
    await d.remote.updateOutput(rp.outputId, { spendable: true, updated_at: later() } as never);
    expect((await d.pull()).refused).toBe(1); // it reached the admission list, and was refused there
    tick(7 * HOUR);
    await admit(d.phone, d.kd.identityKey, d.verifier);
    const got = await d.row(d.phone, planted.id('hex'));
    expect(got.spendable).toBe(false);
    expect(got.change).toBe(false); // quarantined: never funding's pick, whatever frees it
    expect(got.basketId ?? null).toBeNull();
  });

  test("C1/H2: the backup unlinks a coin this device's unsent payment spends (old held mark): it stays spent here", async () => {
    const d = await phoneWithBackup();
    const pending = await unsentSpend(d, d.coin);
    const rc = await d.row(d.remote, d.coin);
    await d.remote.updateOutput(rc.outputId, {
      spendable: false,
      spentBy: undefined,
      spendingDescription: OLD_HELD_MARK,
      updated_at: later(),
    } as never);
    d.chain.answer = 'unspent'; // the chain hasn't seen the device's unsent payment
    await d.pull();
    tick(7 * HOUR);
    await admit(d.phone, d.kd.identityKey, d.verifier);
    const got = await d.row(d.phone, d.coin);
    expect(got.spendable).toBe(false);
    expect(got.spentBy).toBe(pending.id);
  });

  test("C2/H3: delete both id maps on one pull, re-add V's id to the cheap NFT on the next: the id still loads only V", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const receiveOrdinal = async (id: string) => {
      const keyID = `ord-${++n}`;
      const pub = d.kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
      const tx = minedTx(new P2PKH().lock(pub.toAddress()), 1);
      await d.wallet.internalizeAction({
        tx: atomic(tx),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: '1sat',
              customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID }),
              tags: [`id:${id}`],
            },
          },
        ],
        description: 'Ordinal in',
      });
      return tx.id('hex');
    };
    const vTx = await receiveOrdinal('vvvvvvvvvvvv'); // valuable, received first
    const cTx = await receiveOrdinal('cccccccccccc'); // cheap
    await d.sm.updateBackups();
    const userId = await userOf(d.remote, d);
    const rv = await d.row(d.remote, vTx);
    const rc = await d.row(d.remote, cTx);
    const vTag = (await d.remote.findOutputTags({ partial: { userId, tag: 'id:vvvvvvvvvvvv' } }))[0];
    const cTag = (await d.remote.findOutputTags({ partial: { userId, tag: 'id:cccccccccccc' } }))[0];
    const t1 = later();
    await d.remote.updateOutputTagMap(rv.outputId, vTag.outputTagId, { isDeleted: true, updated_at: t1 } as never);
    await d.remote.updateOutputTagMap(rc.outputId, cTag.outputTagId, { isDeleted: true, updated_at: t1 } as never);
    await d.pull(); // page 1: two deletions of tracking ids
    const t2 = later();
    await d.remote.insertOutputTagMap({
      outputId: rc.outputId,
      outputTagId: vTag.outputTagId,
      isDeleted: false,
      created_at: t2,
      updated_at: t2,
    } as never);
    await d.pull(); // page 2: (cheap, id:v)
    const byV = await d.wallet.listOutputs({
      basket: '1sat',
      tags: ['id:vvvvvvvvvvvv'],
      tagQueryMode: 'all',
      limit: 5,
    });
    expect(byV.outputs.map((o) => o.outpoint)).toEqual([`${vTx}.0`]);
    const all = await d.wallet.listOutputs({ basket: '1sat', includeTags: true, limit: 10 });
    const tagsOf = (txid: string) => all.outputs.find((o) => o.outpoint === `${txid}.0`)?.tags ?? [];
    expect(tagsOf(vTx)).toContain('id:vvvvvvvvvvvv');
    expect(tagsOf(cTx)).toEqual(['id:cccccccccccc']);
    expect(await assetIdIsOnly(d.wallet as never, 'vvvvvvvvvvvv', `${vTx}.0`)).toBe(true);
    expect(await assetIdIsOnly(d.wallet as never, 'cccccccccccc', `${cTx}.0`)).toBe(true);
  });

  test('C2: every load of one asset by its tracking id (burn, cancel, adopt) refuses an id two outputs carry', async () => {
    const d = await phoneWithBackup();
    const ord = async (id: string) => {
      const keyID = `ord-${++n}`;
      const pub = d.kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
      const tx = minedTx(new P2PKH().lock(pub.toAddress()), 1);
      await d.wallet.internalizeAction({
        tx: atomic(tx),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: '1sat',
              customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID }),
              tags: [`id:${id}`],
            },
          },
        ],
        description: 'Ordinal in',
      });
      return tx.id('hex');
    };
    const one = await ord('oooooooooooo');
    const w = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: d.sm, services } as never);
    expect(guardAssetIdLoads(w)).toBe(true);
    const loaded = await loadBasketOutput(w as never, '1sat', 'oooooooooooo');
    expect('output' in loaded && loaded.output.outpoint).toBe(`${one}.0`); // honest: one asset, loads
    // Two outputs carrying one id (however they got there): the loader every spend uses is refused.
    const other = await ord('pppppppppppp');
    const userId = await userOf(d.phone, d);
    const tag = (await d.phone.findOutputTags({ partial: { userId, tag: 'id:oooooooooooo' } }))[0];
    const at = new Date();
    await d.phone.insertOutputTagMap({
      outputId: (await d.row(d.phone, other)).outputId,
      outputTagId: tag.outputTagId,
      isDeleted: false,
      created_at: at,
      updated_at: at,
    } as never);
    await expect(loadBasketOutput(w as never, '1sat', 'oooooooooooo')).rejects.toThrow(ASSET_ID_MISMATCH);
    expect(readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8')).toMatch(
      /guardAssetIdLoads\(baseWallet\)/,
    );
  });

  test('C3/H4: the other device aborts an unsent payment; this device frees its input once the chain agrees', async () => {
    const d = await phoneWithBackup();
    const userId = await userOf(d.phone, d);
    const pending = await unsentSpend(d, d.coin, true);
    await d.sm.updateBackups(); // the backup has the unsent payment too (as another device would)
    // The other device aborts it (toolbox abortAction): tx failed, its input spendable again, request invalid.
    const ru = await userOf(d.remote, d);
    const RT = (await d.remote.findTransactions({ partial: { userId: ru, txid: pending.txid }, noRawTx: true }))[0];
    const t = later();
    await d.remote.updateTransaction(RT.transactionId, { status: 'failed', updated_at: t } as never);
    const rc = await d.row(d.remote, d.coin);
    await d.remote.updateOutput(rc.outputId, { spendable: true, spentBy: undefined, updated_at: t } as never);
    const rq = (await d.remote.findProvenTxReqs({ partial: { txid: pending.txid } }))[0];
    await d.remote.updateProvenTxReq(rq.provenTxReqId, {
      status: 'invalid',
      updated_at: new Date(t.getTime() + 5),
    } as never);
    d.chain.knownFor.set(pending.txid, 'unknown'); // never broadcast
    d.chain.answer = 'unspent';
    await d.pull();
    const tx = (await d.phone.findTransactions({ partial: { userId, txid: pending.txid }, noRawTx: true }))[0];
    expect(tx.status).toBe('failed');
    const got = await d.row(d.phone, d.coin);
    expect(got.spendable).toBe(true);
    expect(got.spentBy ?? null).toBeNull();
  });

  test('C4/H5: failed here, completed in the backup, WhatsOnChain unclear once: settled once it answers', async () => {
    const d = await phoneWithBackup();
    const userId = await userOf(d.phone, d);
    const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin }, noRawTx: true }))[0];
    await d.phone.updateTransaction(T.transactionId, { status: 'failed' } as never);
    const c = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(c.outputId, { spendable: false } as never);
    const ru = await userOf(d.remote, d);
    const RT = (await d.remote.findTransactions({ partial: { userId: ru, txid: d.coin }, noRawTx: true }))[0];
    await d.remote.updateTransaction(RT.transactionId, { updated_at: later() } as never);
    const rc = await d.row(d.remote, d.coin);
    await d.remote.updateOutput(rc.outputId, { spendable: true, updated_at: later() } as never);
    d.chain.knownFor.set(d.coin, 'unclear'); // WoC throttled for this one lookup
    d.chain.answer = 'unspent';
    const first = await d.pull();
    expect(first.deferred).toBe(true);
    expect(first.pendingActions).toBe(1); // the restore check counts it as present (C4)
    const status = async () =>
      (await d.phone.findTransactions({ partial: { userId, txid: d.coin }, noRawTx: true }))[0].status;
    expect(await status()).toBe('failed');
    d.chain.knownFor.set(d.coin, 'known'); // WoC back
    tick(2 * MIN);
    await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(await status()).toBe('unproven');
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true);
    const stati = ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal'];
    const listable = async (s: StorageIdb, u: number) =>
      (await s.findTransactions({ partial: { userId: u }, status: stati, noRawTx: true } as never)).length;
    expect(await listable(d.phone, userId)).toBe(await listable(d.remote, ru));
  });

  test("C4: with the wallet's mined-payment repair, a failed->completed correction goes through it, not the backup's word", async () => {
    const d = await phoneWithBackup();
    const userId = await userOf(d.phone, d);
    const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin }, noRawTx: true }))[0];
    await d.phone.updateTransaction(T.transactionId, { status: 'failed' } as never);
    const RT = (
      await d.remote.findTransactions({ partial: { userId: await userOf(d.remote, d), txid: d.coin }, noRawTx: true })
    )[0];
    await d.remote.updateTransaction(RT.transactionId, { updated_at: later() } as never);
    const asked: string[] = [];
    d.verifier.recover = async (txid: string) => (asked.push(txid), 'restored' as const);
    const r = await d.pull();
    expect(asked).toEqual([d.coin]);
    expect(r.applied).toBe(1);
    expect((await d.phone.findTransactions({ partial: { userId, txid: d.coin }, noRawTx: true }))[0].status).toBe(
      'failed',
    ); // left to the repair
  });

  test("C4: a restore whose backup counts an action this device still holds as failed (chain asked) isn't stuck on it", async () => {
    const remote = { outputs: 2, spendableSats: 200, actions: 3, coins: ['a.0', 'b.0'] };
    const local = { outputs: 2, spendableSats: 200, actions: 2, coins: ['a.0', 'b.0'] };
    const run = async (pendingActions: number) => {
      let active: string | undefined = 'r';
      return switchToLocalVerified({
        remoteUrl: 'r',
        activeRemoteUrl: () => active,
        setActiveStorage: async (t) => {
          active = t === 'local' ? undefined : t;
        },
        summarize: async () => (active ? remote : local),
        pullRemote: async () => undefined,
        deviceHolds: async (ops) => new Set(ops),
        admit: async () => ({ pendingActions }),
      });
    };
    expect((await run(1)).ok).toBe(true);
    expect((await run(0)).ok).toBe(false); // genuinely one action short
  });

  test('N1: a forged token row sent not spendable, linked to a backup transaction marked failed: never freed', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const tok = await receiveBsv21(d.wallet, d.kd, 100n);
    await d.sm.updateBackups();
    const r = await d.row(d.remote, tok);
    const X = await backupTx(d, 'failed'); // no proof request: "safe" for the toolbox to free what it spent
    await d.remote.updateOutput(r.outputId, {
      customInstructions: JSON.stringify({ ...JSON.parse(r.customInstructions!), amt: '1000000' }),
      spendable: false,
      spentBy: X.id,
      updated_at: later(),
    } as never);
    const { fresh, sm2, unregister } = await d.restore();
    await fresh.reviewStatus({ agedLimit: new Date() } as never); // the device's own monitor
    expect((await tokenSend(d, sm2)).find((o) => o.outpoint.startsWith(tok))).toBeUndefined();
    expect((await d.row(fresh, tok)).spendable).toBe(false);
    unregister();
  });

  test('N1: no spend link goes on a coin the device holds as not spendable (a later failure would free it)', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never); // e.g. spent, or held back here
    const X = await backupTx(d, 'failed');
    await d.forge(d.coin, { spendable: false, spentBy: X.id });
    await d.pull();
    expect((await d.row(d.phone, d.coin)).spentBy ?? null).toBeNull();
    await d.phone.reviewStatus({ agedLimit: new Date() } as never);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
  });

  test('N1: honest: a coin another device spent arrives spent, linked when that payment is completed', async () => {
    const d = await phoneWithBackup();
    const { fresh, unregister } = await d.restore({ ...d.verifier, spent: async () => ({ state: 'unspent' }) });
    const X = await backupTx(d, 'completed');
    await d.forge(d.coin2, { spendable: false, spentBy: X.id }); // spent by a completed payment
    const sm3 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm3.makeAvailable();
    await sm3.setActive(fresh.getSettings().storageIdentityKey);
    await sm3.syncFromReader(d.kd.identityKey, d.remote as never);
    const got = await d.row(fresh, d.coin2);
    expect(got.spendable).toBe(false); // the device had it spendable: marked spent, link and all
    expect(got.spentBy).toBeGreaterThan(0);
    unregister();
  });

  test('C5: the chain is asked with no storage lock held: the wallet stays usable while WhatsOnChain is slow', async () => {
    const d = await phoneWithBackup();
    await d.forge(d.coin, { spendable: true });
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.merge();
    let answer: (s: SpendState) => void = () => undefined;
    const slow: InboundVerifier = {
      ...d.verifier,
      spent: () => new Promise<SpendState>((resolve) => (answer = resolve)),
    };
    const run = admit(d.phone, d.kd.identityKey, slow);
    await new Promise((r) => setTimeout(r, 20));
    const meanwhile = await Promise.race([
      d.sm.runAsStorageProvider(async () => 'locks free'),
      new Promise((r) => setTimeout(() => r('blocked'), 1500)),
    ]);
    expect(meanwhile).toBe('locks free');
    answer({ state: 'unspent' });
    expect((await run).admitted).toBe(1);
  }, 20_000);

  test('C5: one run looks at 25 entries, and stops at the first unclear answer', async () => {
    const d = await phoneWithBackup();
    const list = (await import('./inboundSync')).admissionListFor(d.phone.getSettings().storageIdentityKey);
    const ghosts = Array.from({ length: 30 }, () => ({
      kind: 'coin' as const,
      txid: Utils.toHex(Random(32)),
      vout: 0,
    }));
    // Rows the device doesn't hold (yet: their page may still be merging, D3): each waits, no chain call.
    await list.add(d.kd.identityKey, ghosts, now());
    const r = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(r.waiting).toBe(25);
    expect(r.refused).toBe(0);
    expect(r.left).toBe(30);
    expect(d.chain.asked).toEqual([]);
    await admit(d.phone, d.kd.identityKey, d.verifier);
    // Two coins waiting, WhatsOnChain unclear: asked once, then the run stops.
    for (const c of [d.coin, d.coin2]) {
      const o = await d.row(d.phone, c);
      await d.phone.updateOutput(o.outputId, { spendable: false } as never);
    }
    await list.add(
      d.kd.identityKey,
      [d.coin, d.coin2].map((txid) => ({ kind: 'coin' as const, txid, vout: 0 })),
      now(),
    );
    d.chain.answer = 'unclear';
    const u = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(u.deferred).toBe(true);
    expect(d.chain.asked.length).toBe(1);
    // Backed off: an immediate run asks nothing more about the coin it asked.
    d.chain.asked.length = 0;
    await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(d.chain.asked.length).toBeLessThanOrEqual(1);
  }, 20_000); // real IndexedDB work for 30 entries: over bun's 5 s default under a loaded full-suite run

  test('D2: a coin waiting only on the chain is never given up on: admitted whenever the chain learns of it', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin, 'unknown');
    const { fresh, unregister } = await d.restore();
    expect(await waiting(fresh, d.kd.identityKey)).toEqual([`${d.coin}.0`]);
    for (let i = 0; i < 20; i++) {
      tick(7 * HOUR);
      expect((await admit(fresh, d.kd.identityKey, d.verifier)).retired).toBe(0);
    }
    expect(await waiting(fresh, d.kd.identityKey)).toEqual([`${d.coin}.0`]); // 5 days on, still asked
    d.chain.knownFor.set(d.coin, 'known');
    tick(7 * HOUR);
    expect((await admit(fresh, d.kd.identityKey, d.verifier)).admitted).toBe(1);
    expect((await d.row(fresh, d.coin)).spendable).toBe(true);
    unregister();
  });

  test("C5/D2: only a wait on this device's own state is given up after 3 days (its own payment still unsent)", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    await unsentSpend(d, d.coin);
    await d.forge(d.coin, { spendable: true, spentBy: undefined });
    await d.pull();
    expect(await waiting(d.phone, d.kd.identityKey)).toEqual([`${d.coin}.0`]);
    let retired = 0;
    for (let i = 0; i < 20 && !retired; i++) {
      tick(7 * HOUR);
      retired = (await admit(d.phone, d.kd.identityKey, d.verifier)).retired;
    }
    expect(retired).toBe(1);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false); // its own payment still spends it
  });

  test('C6: the restore switch admits what the copy queued before it compares, with no later pull', async () => {
    const d = await phoneWithBackup();
    const name = `c6-${++n}`;
    const local = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    (local as unknown as { dbName: string }).dbName = name;
    await local.migrate(name, `sik-${name}`);
    const v: InboundVerifier = {
      ...d.verifier,
      spent: async () => ({ state: 'unspent' }),
      txKnown: async () => 'known',
    };
    const unregister = registerInboundVerifier(`sik-${name}`, d.kd.identityKey, v);
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
    let switched = false;
    const r = await switchToLocalVerified({
      remoteUrl,
      activeRemoteUrl: () => core.storage.getStores().find((s) => s.isActive && !s.isConflicting)?.endpointURL,
      setActiveStorage: core.setActiveStorage,
      summarize: () => summarizeActive(core.wallet as never),
      pullRemote: async () => undefined,
      deviceHolds: outpointsOnDevice(core.storage as never),
      admit: () => admit(local, d.kd.identityKey, v),
      onSwitched: () => void (switched = true),
    });
    expect(r.ok).toBe(true);
    expect(switched).toBe(true);
    for (const txid of [d.coin, d.coin2]) expect((await d.row(local, txid)).spendable).toBe(true);
    unregister();
  });

  test("C7: a spent answer is asked once more an hour later (a mempool spend can drop), then it's final", async () => {
    const d = await phoneWithBackup();
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'spent';
    await d.pull();
    expect(await waiting(d.phone, d.kd.identityKey)).toEqual([`${d.coin}.0`]);
    d.chain.answer = 'unspent'; // its spender was dropped from the mempool
    tick(HOUR + MIN);
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).admitted).toBe(1);
    // Spent twice, an hour apart: dropped from the list, the coin stays spent.
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    d.chain.answer = 'spent';
    await d.pull();
    tick(HOUR + MIN);
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).refused).toBe(1);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(false);
  });

  test("C7: an 'unfail' request or status from the backup is never taken (it would restore outputs on the chain's word)", async () => {
    const d = await phoneWithBackup();
    const X = await backupTx(d, 'failed');
    const at = later();
    await d.remote.insertProvenTxReq({
      provenTxReqId: 0,
      created_at: at,
      updated_at: at,
      txid: X.txid,
      status: 'unfail',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx: [1, 2, 3],
    } as never);
    const RT = (await d.remote.findTransactions({ partial: { txid: d.coin }, noRawTx: true }))[0];
    await d.remote.updateTransaction(RT.transactionId, { status: 'unfail', updated_at: later() } as never);
    await d.pull();
    expect((await d.phone.findProvenTxReqs({ partial: { txid: X.txid } })).map((q) => q.status)).toEqual(['unknown']);
    const userId = await userOf(d.phone, d);
    expect((await d.phone.findTransactions({ partial: { userId, txid: d.coin }, noRawTx: true }))[0].status).toBe(
      'completed',
    );
  });

  test("a page whose admissions can't be written to the device's list is not taken (fetched again), and isn't a broken backup", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const fresh = await store(`c-list-${++n}`);
    const off = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, d.verifier);
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    const idb = globalThis.indexedDB;
    const open = idb.open.bind(idb);
    idb.open = ((name: string, version?: number) => {
      if (name.startsWith('bwx-inbound-admission-')) throw new Error('quota');
      return open(name, version);
    }) as typeof idb.open;
    const copy = async () => {
      await sm2.makeAvailable();
      await sm2.setActive(fresh.getSettings().storageIdentityKey); // merges the backup in (it claims to be active)
      await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    };
    try {
      const err = await copy().catch((e: unknown) => e);
      expect(isUncheckedPage(err)).toBe(true);
    } finally {
      idb.open = open as typeof idb.open;
    }
    expect((await fresh.findOutputs({ partial: { spendable: true } })).length).toBe(0);
    await copy();
    await admit(fresh, d.kd.identityKey, d.verifier);
    for (const txid of [d.coin, d.coin2]) expect((await d.row(fresh, txid)).spendable).toBe(true);
    off();
  });
});

/**
 * Review 16d: honest funds must never be stranded (D1-D3, D6), and two more ways a backup's claim stood in for the
 * chain's (D4, D5, D7). The reviewer's scratch repros, asserting the fixed behaviour, and their honest counterparts.
 */
describe('16d: every honest coin comes back; no row stands in for the chain', () => {
  type D = Awaited<ReturnType<typeof phoneWithBackup>>;
  const DAY = 24 * HOUR;
  let clockAt = 1;
  const later = () => new Date(Date.now() + HOUR * clockAt++);
  const userOf = async (s: StorageIdb, d: D) =>
    (await s.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0].userId;
  /** The device's row for this txid's output 0, found by its transaction (works for a row with no txid). */
  const rowByTx = async (s: StorageIdb, d: D, txid: string) => {
    const userId = await userOf(s, d);
    const t = (await s.findTransactions({ partial: { userId, txid }, noRawTx: true }))[0];
    return t ? (await s.findOutputs({ partial: { userId, transactionId: t.transactionId, vout: 0 } }))[0] : undefined;
  };
  const pullInto = (sm2: WalletStorageManager, d: D) => sm2.syncFromReader(d.kd.identityKey, d.remote as never);
  const TOKEN = `${'ef'.repeat(32)}_0`;
  /** The chain's copy of transactions it has, for a verifier that asks for them (D5). */
  const withChainCopies = (d: D, txs: Transaction[]): InboundVerifier => ({
    ...d.verifier,
    chainTx: async (txid: string) => {
      const k = d.chain.knownFor.get(txid) ?? d.chain.known;
      if (k === 'unclear') return { state: 'unclear' };
      const tx = txs.find((t) => t.id('hex') === txid);
      return k === 'known' && tx ? { state: 'found', rawTx: tx.toBinary() } : { state: 'unknown' };
    },
  });
  /** A transaction row on the backup (a copy of a real one's), no raw bytes unless given. */
  const backupTx = async (d: D, txid: string, raw?: Transaction, status = 'completed') => {
    const ru = await userOf(d.remote, d);
    const RT = (await d.remote.findTransactions({ partial: { userId: ru, txid: d.coin2 }, noRawTx: true }))[0];
    const t = later();
    return d.remote.insertTransaction({
      ...RT,
      transactionId: 0,
      txid,
      reference: Utils.toBase64(Random(12)),
      status,
      rawTx: raw ? raw.toBinary() : undefined,
      provenTxId: undefined,
      created_at: t,
      updated_at: t,
    } as never);
  };
  /** Wallet change on the backup at (txid, 0): this script, these satoshis, the derivation given. */
  const backupChange = async (
    d: D,
    transactionId: number,
    txid: string,
    script: Script,
    satoshis: number,
    derivation: { derivationPrefix: string; derivationSuffix: string; senderIdentityKey?: string },
  ) => {
    const legit = await d.row(d.remote, d.coin2);
    const t = later();
    await d.remote.insertOutput({
      ...legit,
      outputId: 0,
      transactionId,
      txid,
      vout: 0,
      satoshis,
      lockingScript: script.toBinary(),
      scriptLength: script.toBinary().length,
      scriptOffset: 0,
      ...derivation,
      spendable: true,
      spentBy: undefined,
      created_at: t,
      updated_at: t,
    } as never);
  };

  test('D1: an honest coin whose row reached the backup with no txid is restored, its txid filled in', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    // The origin device pushed this coin while its row had no txid (the 30 Oct "A truthy value is required" rows).
    const r = await d.row(d.remote, d.coin2);
    await d.remote.updateOutput(r.outputId, { txid: undefined, updated_at: later() } as never);
    const { fresh, sm2, unregister } = await d.restore();
    const got = await rowByTx(fresh, d, d.coin2);
    expect(got?.spendable).toBe(true);
    expect(got?.txid).toBe(d.coin2);
    expect(got?.basketId ?? null).not.toBeNull();
    // The origin's nullTxidRepair pushes the fixed row later: nothing changes, nothing is stranded.
    await d.remote.updateOutput(r.outputId, { txid: d.coin2, updated_at: later() } as never);
    await pullInto(sm2, d);
    await admit(fresh, d.kd.identityKey, d.verifier);
    expect((await rowByTx(fresh, d, d.coin2))?.spendable).toBe(true);
    unregister();
  });

  test('D1: a coin the device holds without a txid, revived by the backup, is found by its transaction and admitted', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const mine = await d.row(d.phone, d.coin2);
    await d.phone.updateOutput(mine.outputId, { spendable: false, txid: undefined } as never); // the 30 Oct state
    await d.forge(d.coin2, { spendable: true });
    await d.pull();
    const got = await rowByTx(d.phone, d, d.coin2);
    expect(got?.spendable).toBe(true);
    expect(got?.txid).toBe(d.coin2);
  });

  test('D2: one WhatsOnChain hiccup after day 3 no longer retires an honest coin; it is admitted once WoC answers', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin2, 'unknown'); // WoC lag at restore time for this one
    const { fresh, unregister } = await d.restore();
    expect((await d.row(fresh, d.coin)).spendable).toBe(true);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(false); // waiting
    tick(4 * DAY);
    d.chain.knownFor.delete(d.coin2);
    d.chain.answer = 'unclear'; // throttled (429 x4)
    const r1 = await admit(fresh, d.kd.identityKey, d.verifier);
    expect(r1.retired).toBe(0);
    expect(r1.nextAt).toBeGreaterThan(now()); // the caller's next run is scheduled for it
    d.chain.answer = 'unspent';
    tick(2 * MIN);
    await admit(fresh, d.kd.identityKey, d.verifier);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    unregister();
  });

  test('D2: while WhatsOnChain has no answer, the second source (the 1Sat stack) decides', async () => {
    const d = await phoneWithBackup();
    const woc = { spent: async () => ({ state: 'unclear' as const }), txKnown: async () => 'unclear' as const };
    const oneSat = {
      spent: async () => ({ state: 'unspent' as const }),
      txKnown: async () => 'known' as const,
      chainTx: async () => ({ state: 'unclear' as const }),
    };
    const both = eitherChainSource({ ...woc, chainTx: async () => ({ state: 'unclear' }) }, () => oneSat);
    const v: InboundVerifier = { ...d.verifier, ...both };
    const mine = await d.row(d.phone, d.coin);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin, { spendable: true });
    await d.merge();
    expect((await admit(d.phone, d.kd.identityKey, v)).admitted).toBe(1);
    expect((await d.row(d.phone, d.coin)).spendable).toBe(true);
  });

  test('D2: admission runs again at the next try, on the 5-minute alarm, and when the app comes to the front', () => {
    const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(init).toMatch(/if \(r\?\.nextAt !== undefined\) admitIn\(r\.nextAt - Date\.now\(\)\)/);
    expect(init).toMatch(/useSecondSource\(oneSatChainLookups\(toolboxServices\)\)/);
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toMatch(/alarm\.name === AUTO_COIN_RESYNC_ALARM\) void accountContext\?\.admitBackupRows\(\)/);
    expect(bg).toMatch(/pageHidden\(\) === false\) void accountContext\?\.admitBackupRows\(\)/);
  });

  test('D3: a run between a page writing its admissions and its merge: those coins wait, and come back', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const fresh = await store(`d3-race-${++n}`);
    const off = registerInboundVerifier(fresh.getSettings().storageIdentityKey, d.kd.identityKey, d.verifier);
    let fired = false;
    const orig = fresh.findProvenTxs.bind(fresh);
    // processSyncChunk's own proof lookup runs after the guard wrote the page's admissions, before the merge.
    (fresh as unknown as { findProvenTxs: typeof orig }).findProvenTxs = async (a: never) => {
      if (!fired && (a as { txids?: unknown }).txids) {
        fired = true;
        await admit(fresh, d.kd.identityKey, d.verifier); // e.g. the onQueued timer from an earlier page
      }
      return orig(a);
    };
    const sm2 = new WalletStorageManager(d.kd.identityKey, fresh, [d.remote]);
    await sm2.makeAvailable();
    await sm2.setActive(fresh.getSettings().storageIdentityKey);
    sm2.setServices(services);
    await sm2.syncFromReader(d.kd.identityKey, d.remote as never);
    expect(fired).toBe(true);
    tick(2 * MIN);
    await admit(fresh, d.kd.identityKey, d.verifier);
    expect((await d.row(fresh, d.coin)).spendable).toBe(true);
    expect((await d.row(fresh, d.coin2)).spendable).toBe(true);
    off();
  });

  test('D4: a plain P2PKH row in the bsv21 basket with a token record (amt, id) is never read as tokens', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const keyID = `tok-${++n}`;
    const pub = d.kd.derivePublicKey([0, 'onesat'], keyID, 'self', true);
    const real = minedTx(bsv21(TOKEN, 100n, pub.toAddress()), 1);
    await d.wallet.internalizeAction({
      tx: atomic(real),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: 'bsv21',
            tags: [`bsv21:${TOKEN}`],
            customInstructions: JSON.stringify({ protocolID: [0, 'onesat'], keyID, id: TOKEN, amt: '100' }),
          },
        },
      ],
      description: 'Tokens in',
    });
    await d.sm.updateBackups();
    const honest = await d.row(d.remote, real.id('hex'));
    // A real 1-sat P2PKH output paying a key the wallet derives (counterparty = the attacker), with a token record.
    const attacker = PrivateKey.fromRandom().toPublicKey().toString();
    const key = d.kd.derivePublicKey([0, 'onesat'], 'x1', attacker, false);
    const planted = minedTx(new P2PKH().lock(key.toAddress()), 1);
    const ptxid = planted.id('hex');
    const tid = await backupTx(d, ptxid, planted);
    const t = later();
    await d.remote.insertOutput({
      ...honest,
      outputId: 0,
      transactionId: tid,
      txid: ptxid,
      vout: 0,
      satoshis: 1,
      lockingScript: planted.outputs[0].lockingScript.toBinary(),
      scriptLength: planted.outputs[0].lockingScript.toBinary().length,
      scriptOffset: 0,
      customInstructions: JSON.stringify({
        protocolID: [0, 'onesat'],
        keyID: 'x1',
        counterparty: attacker,
        id: TOKEN,
        amt: '1000000',
      }),
      spendable: true,
      spentBy: undefined,
      created_at: t,
      updated_at: t,
    } as never);
    const { fresh, sm2, unregister } = await d.restore();
    const w2 = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: sm2, services } as never);
    const listed = await w2.listOutputs({ basket: 'bsv21', includeCustomInstructions: true, includeTags: true });
    const read = listed.outputs.map((o) => ({ outpoint: o.outpoint, ...bsv21FieldsFromOutput(o as never) }));
    expect((await d.row(fresh, ptxid)).spendable).toBe(false);
    expect(read.find((o) => o.outpoint.startsWith(ptxid))).toBeUndefined();
    expect(read.find((o) => o.outpoint.startsWith(real.id('hex')))?.amt).toBe('100'); // the honest token still is
    unregister();
  });

  test('D5: planted wallet "change" sent with no raw tx is never admitted on the row\'s own word', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const ptxid = Utils.toHex(Random(32));
    const tid = await backupTx(d, ptxid);
    const attacker = PrivateKey.fromRandom().toPublicKey();
    const derivationPrefix = Utils.toBase64(Random(8));
    const derivationSuffix = Utils.toBase64(Random(8));
    const pub = d.kd.derivePublicKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, attacker, true);
    await backupChange(d, tid, ptxid, new P2PKH().lock(pub.toAddress()), 1_000_000_000, {
      derivationPrefix,
      derivationSuffix,
      senderIdentityKey: attacker.toString(),
    });
    const { fresh, sm2, unregister } = await d.restore();
    for (let i = 0; i < 3; i++) {
      tick(7 * HOUR);
      await admit(fresh, d.kd.identityKey, d.verifier);
    }
    expect((await d.row(fresh, ptxid)).spendable).toBe(false);
    const w2 = new Wallet({ chain: 'main', keyDeriver: d.kd, storage: sm2, services } as never);
    const bal = (await w2.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0);
    expect(bal).toBeLessThan(1_000_000_000);
    unregister();
  });

  test("D5: the chain's copy of the transaction decides: another script or amount there is refused, a match admitted", async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const attacker = PrivateKey.fromRandom().toPublicKey();
    const der = () => ({ derivationPrefix: Utils.toBase64(Random(8)), derivationSuffix: Utils.toBase64(Random(8)) });
    const keyOf = (x: { derivationPrefix: string; derivationSuffix: string }) =>
      new P2PKH().lock(
        d.kd.derivePublicKey(BRC29, `${x.derivationPrefix} ${x.derivationSuffix}`, attacker, true).toAddress(),
      );
    // A real transaction paying a stranger 5,000 sats; the backup's row says it is 10 BSV of wallet change.
    const forged = der();
    const real = minedTx(new P2PKH().lock(PrivateKey.fromRandom().toAddress()), 5_000);
    await backupChange(d, await backupTx(d, real.id('hex')), real.id('hex'), keyOf(forged), 1_000_000_000, {
      ...forged,
      senderIdentityKey: attacker.toString(),
    });
    // An honest coin whose raw transaction the backup didn't send: the chain's copy matches it.
    const fair = der();
    const honest = minedTx(keyOf(fair), 7_000);
    await backupChange(d, await backupTx(d, honest.id('hex')), honest.id('hex'), keyOf(fair), 7_000, {
      ...fair,
      senderIdentityKey: attacker.toString(),
    });
    const { fresh, unregister } = await d.restore(withChainCopies(d, [real, honest]));
    expect((await d.row(fresh, real.id('hex'))).spendable).toBe(false);
    expect(await waiting(fresh, d.kd.identityKey)).not.toContain(`${real.id('hex')}.0`); // refused, not waiting
    expect((await d.row(fresh, honest.id('hex'))).spendable).toBe(true);
    unregister();
  });

  test('D6: failed here, completed in the backup, the chain has it, the repair finds nothing: settled, inputs spent', async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const userId = await userOf(d.phone, d);
    // X spent this device's coin, then failed here (its broadcast refused); it was mined all the same.
    const x = new Transaction();
    x.addInput({ sourceTXID: d.coin, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    x.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 49_000 });
    const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin2 }, noRawTx: true }))[0];
    const at = new Date();
    await d.phone.insertTransaction({
      ...T,
      transactionId: 0,
      txid: x.id('hex'),
      reference: Utils.toBase64(Random(12)),
      status: 'failed',
      rawTx: x.toBinary(),
      provenTxId: undefined,
      isOutgoing: true,
      created_at: at,
      updated_at: at,
    } as never);
    await d.sm.updateBackups();
    const ru = await userOf(d.remote, d);
    const RX = (await d.remote.findTransactions({ partial: { userId: ru, txid: x.id('hex') }, noRawTx: true }))[0];
    await d.remote.updateTransaction(RX.transactionId, { status: 'completed', updated_at: later() } as never);
    const v: InboundVerifier = { ...d.verifier, recover: async () => 'done' as const }; // recoverTxid: 'not-ours'
    await d.merge();
    const r = await admitPending(d.phone as never, d.kd.identityKey, v, { now });
    expect(r.applied).toBe(1);
    const settled = (await d.phone.findTransactions({ partial: { userId, txid: x.id('hex') }, noRawTx: true }))[0];
    expect(settled.status).toBe('unproven'); // the monitor proves it from here
    const coin = await d.row(d.phone, d.coin);
    expect(coin.spendable).toBe(false); // spent by X, as on chain
    expect(coin.spentBy).toBe(settled.transactionId);
  });

  test("D7: this device's own just-broadcast payment is not failed on a backup's word while WoC lags", async () => {
    const d = await phoneWithBackup();
    const userId = await userOf(d.phone, d);
    const T = (await d.phone.findTransactions({ partial: { userId, txid: d.coin2 }, noRawTx: true }))[0];
    await d.phone.updateTransaction(T.transactionId, { status: 'unproven', provenTxId: undefined } as never);
    const at = new Date();
    await d.phone.insertProvenTxReq({
      provenTxReqId: 0,
      created_at: at,
      updated_at: at,
      txid: d.coin2,
      status: 'unmined', // its own broadcast went out; its monitor is waiting for the proof
      attempts: 1,
      notified: false,
      history: '{}',
      notify: '{}',
      rawTx: [1, 2, 3],
    } as never);
    const ru = await userOf(d.remote, d);
    const RT = (await d.remote.findTransactions({ partial: { userId: ru, txid: d.coin2 }, noRawTx: true }))[0];
    await d.remote.updateTransaction(RT.transactionId, {
      status: 'failed',
      provenTxId: undefined,
      updated_at: later(),
    } as never);
    d.chain.knownFor.set(d.coin2, 'unknown'); // WoC lag (seconds to minutes after broadcast)
    await d.pull();
    expect((await d.phone.findTransactions({ partial: { userId, txid: d.coin2 }, noRawTx: true }))[0].status).toBe(
      'unproven',
    );
  });
});

describe('5 Nov 2026: a pull the receive watcher asked for is admitted within seconds, under every check', () => {
  /** The phone holds coin2 as not spendable; the backup (the other device) says spendable: an admission entry. */
  const listed = async () => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    d.chain.knownFor.set(d.coin2, 'unknown'); // WhatsOnChain has not indexed the other device's transaction yet
    const mine = await d.row(d.phone, d.coin2);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    await d.forge(d.coin2, { spendable: true });
    return d;
  };

  test('entries from that pull are asked again every few seconds inside the window, tries not counted', async () => {
    const d = await listed();
    const from = now();
    await d.merge();
    const prompt = { from, until: from + 2 * MIN };
    const r1 = await admitPending(d.phone as never, d.kd.identityKey, d.verifier, { now, prompt });
    expect(r1.waiting).toBe(1);
    expect(r1.admitted).toBe(0);
    expect(r1.nextAt! - now()).toBeLessThanOrEqual(PROMPT_RETRY_MS);
    expect(r1.nextAt! - now()).toBeGreaterThan(PROMPT_RETRY_MS - 1_000);
    expect((await pendingAdmissions(d.phone as never, d.kd.identityKey))[0].tries).toBe(0);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(false); // nothing admitted before the chain says so
    tick(PROMPT_RETRY_MS);
    d.chain.knownFor.delete(d.coin2);
    const r2 = await admitPending(d.phone as never, d.kd.identityKey, d.verifier, { now, prompt });
    expect(r2.admitted).toBe(1);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(true);
  });

  test('entries listed before the pull, and any entry once the window has passed, keep the 1-minute doubling', async () => {
    const d = await listed();
    await d.merge();
    await admit(d.phone, d.kd.identityKey, d.verifier); // tries 1, next in a minute
    tick(MIN);
    const from = now(); // a later pull: this entry was listed before it
    const r = await admitPending(d.phone as never, d.kd.identityKey, d.verifier, {
      now,
      prompt: { from, until: from + 2 * MIN },
    });
    expect(r.nextAt! - now()).toBeGreaterThan(2 * MIN - 1_000); // doubled, not the prompt retry
    const d2 = await listed();
    const from2 = now();
    await d2.merge();
    tick(3 * MIN); // the window is over
    const r2 = await admitPending(d2.phone as never, d2.kd.identityKey, d2.verifier, {
      now,
      prompt: { from: from2, until: from2 + 2 * MIN },
    });
    expect(r2.nextAt! - now()).toBeGreaterThan(MIN - 1_000);
  });
});

/**
 * 6 Nov 2026, the owner's iPhone: f8e91f14:0, a1972e3f:0 and c9959acb:2/:3 (about 12.1M sats) were queued while every
 * page merge was rolling back, so each try found no row and waited with a doubling back-off (tries 9, next try ~4 h
 * away). The 07:46 deep pull then merged their rows and listed them again, but the list kept the old timer, so the
 * coins stayed not spendable for hours. Re-listing, or the row being here now, makes an entry due at once.
 */
describe('6 Nov 2026: an admission entry that waited for its row is not held back once the row is here', () => {
  const sikOf = (d: Awaited<ReturnType<typeof phoneWithBackup>>) => d.phone.getSettings().storageIdentityKey;
  /** The phone holds coin2 as not spendable; the backup says spendable; the entry carries the earlier tries. */
  const stale = async (entry: Partial<{ waitingFor: 'row' | 'other'; tries: number; nextIn: number }> = {}) => {
    const d = await phoneWithBackup();
    d.chain.answer = 'unspent';
    const mine = await d.row(d.phone, d.coin2);
    await d.phone.updateOutput(mine.outputId, { spendable: false } as never);
    const list = (await import('./inboundSync')).admissionListFor(sikOf(d));
    await list.put({
      kind: 'coin',
      txid: d.coin2,
      vout: 0,
      key: `${d.kd.identityKey}|coin|${d.coin2}.0`,
      identityKey: d.kd.identityKey,
      firstAt: now() - 5 * HOUR,
      nextAt: now() + (entry.nextIn ?? 4 * HOUR),
      tries: entry.tries ?? 9,
      ...(entry.waitingFor ? { waitingFor: entry.waitingFor } : {}),
    });
    return d;
  };

  test('a pull that lists the coin again resets its back-off: admitted on the chain word, not 4 hours later', async () => {
    const d = await stale({ waitingFor: 'row' });
    await d.forge(d.coin2, { spendable: true }); // the page carrying it again (a deep pull)
    await d.merge();
    const [e] = await pendingAdmissions(d.phone as never, d.kd.identityKey);
    expect(e.tries).toBe(0);
    expect(e.nextAt).toBeLessThanOrEqual(now());
    expect(e.firstAt).toBeLessThan(now() - 4 * HOUR); // its first time is kept (the 3-day give-up counts from it)
    const r = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(r.admitted).toBe(1);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(true);
    expect(d.chain.asked).toEqual([`${d.coin2}.0`]); // the chain still decided
  });

  test("an entry left from before (no reason kept) whose row is here now is due: the phone's held coins", async () => {
    const d = await stale(); // as the phone's list holds them: tries 9, no reason
    const r = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(r.admitted).toBe(1);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(true);
  });

  test('an entry that waited on the chain keeps its back-off: no early question', async () => {
    const d = await stale({ waitingFor: 'other', tries: 3, nextIn: HOUR });
    const r = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(r.admitted).toBe(0);
    expect(d.chain.asked).toEqual([]);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(false);
    tick(HOUR);
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).admitted).toBe(1);
  });

  test('review: a chain-waiting entry that a page lists again keeps its back-off and is not prompt-polled', async () => {
    const d = await stale({ waitingFor: 'other', tries: 3, nextIn: HOUR });
    const from = now();
    await d.forge(d.coin2, { spendable: true }); // a page carrying it again
    await d.merge();
    const [e] = await pendingAdmissions(d.phone as never, d.kd.identityKey);
    expect([e.tries, e.nextAt > now()]).toEqual([3, true]);
    const prompt = { from, until: from + 2 * MIN };
    const r = await admitPending(d.phone as never, d.kd.identityKey, d.verifier, { now, prompt });
    expect(r.admitted).toBe(0);
    expect(d.chain.asked).toEqual([]); // WhatsOnChain is not asked early, nor every 5 s
  });

  test("review: the row look-ups rotate, so entries past a run's budget are reached on the next runs", async () => {
    const d = await stale({ waitingFor: 'row' }); // coin2's row is here; its entry waits as if it weren't
    const list = (await import('./inboundSync')).admissionListFor(sikOf(d));
    // Five entries whose rows never come, all sorting before coin2's, all with the stale back-off.
    for (let i = 0; i < 5; i++)
      await list.put({
        kind: 'coin',
        txid: `000${i}${Utils.toHex(Random(30))}`,
        vout: 0,
        key: `${d.kd.identityKey}|coin|!${i}.0`, // '!' sorts before any txid
        identityKey: d.kd.identityKey,
        firstAt: now() - 5 * HOUR,
        nextAt: now() + 4 * HOUR,
        tries: 9,
        waitingFor: 'row',
      });
    // limit 1: four row look-ups a run.
    const run = () => admitPending(d.phone as never, d.kd.identityKey, d.verifier, { now, limit: 1 });
    let admitted = 0;
    for (let i = 0; i < 3; i++) admitted += (await run()).admitted;
    expect(admitted).toBe(1);
    expect((await d.row(d.phone, d.coin2)).spendable).toBe(true);
  });

  test('a row still missing waits as before, with no chain call, and is marked as waiting for its row', async () => {
    const d = await phoneWithBackup();
    const list = (await import('./inboundSync')).admissionListFor(sikOf(d));
    const ghost = Utils.toHex(Random(32));
    await list.add(d.kd.identityKey, [{ kind: 'coin', txid: ghost, vout: 0 }], now());
    const r = await admit(d.phone, d.kd.identityKey, d.verifier);
    expect(r.waiting).toBe(1);
    expect(d.chain.asked).toEqual([]);
    const [e] = await pendingAdmissions(d.phone as never, d.kd.identityKey);
    expect([e.tries, e.waitingFor]).toEqual([1, 'row']);
    // The next run, before its time: still missing, so still not due and not asked about.
    expect((await admit(d.phone, d.kd.identityKey, d.verifier)).waiting).toBe(0);
    expect(d.chain.asked).toEqual([]);
  });
});
