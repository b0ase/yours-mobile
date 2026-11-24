/**
 * The first fill of a new backup (services/backupFill.ts; review of the instant restore, finding 4): the whole wallet
 * reaches the backup without the storage locks held for it, nothing a payment changes meanwhile is lost, and the
 * ordinary push afterwards starts from the backup's cursor. Real toolbox stores on fake-indexeddb; random keys.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { fillBackup, FillIncompleteError, type FillManager, type FillProgress } from './backupFill';
import { installInboundSyncGuard } from './inboundSync';

const services = {
  chain: 'main',
  getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => 2_000_000 }),
  getHeight: async () => 2_000_000,
  getHeaderForHeight: async () => new Array(80).fill(0),
  nLockTimeIsFinal: async () => true,
  postBeef: async (_beef: unknown, txids: string[]) => [
    { name: 'fake', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
  ],
} as never;

let seq = 0;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `fill-${name}-${++seq}-${Date.now()}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

let height = 950_000;
async function receive(w: Wallet, kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(++height, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  await w.internalizeAction({
    tx: beef.toBinaryAtomic(txid),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
      },
    ],
    description: 'payment',
  });
  return txid;
}

/** A device with `n` coins, and an empty backup whose user row names the device (as addOurBackup leaves it). */
async function setup(n: number) {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const dev = await store('dev');
  const backup = await store('backup');
  const sm = new WalletStorageManager(kd.identityKey, dev);
  await sm.makeAvailable();
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  for (let i = 0; i < n; i++) await receive(wallet, kd, 1000 + i);
  const { user } = await backup.findOrInsertUser(kd.identityKey);
  await backup.setActive(
    { identityKey: kd.identityKey, userId: user.userId } as never,
    dev.getSettings().storageIdentityKey,
  );
  const locks = { held: false, count: 0 };
  const manager = sm as unknown as FillManager;
  const real = manager.runAsSync.bind(sm);
  (manager as unknown as { runAsSync: unknown }).runAsSync = async (
    fn: (a: unknown) => Promise<unknown>,
    ...rest: unknown[]
  ) =>
    (real as (...a: unknown[]) => Promise<unknown>)(
      async (a: unknown) => {
        const outer = !locks.held;
        if (outer) locks.count++;
        locks.held = true;
        try {
          return await fn(a);
        } finally {
          if (outer) locks.held = false;
        }
      },
      ...rest,
    );
  return { kd, dev, backup, sm, wallet, manager, locks };
}

const rows = async (s: StorageIdb) => ({
  outputs: (await s.findOutputs({ partial: {} })).map((o) => `${o.txid}.${o.vout}:${o.spendable}`).sort(),
  transactions: (await s.findTransactions({ partial: {} })).map((t) => `${t.txid}:${t.status}`).sort(),
});

describe('first fill of a new backup', () => {
  test('two passes: the bulk without the locks, then only what changed meanwhile inside them', async () => {
    const x = await setup(12);
    const lockedDuringBulk: boolean[] = [];
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 5,
      pageGapMs: 0,
      afterPage: async () => void lockedDuringBulk.push(x.locks.held),
    });
    expect(r.how).toBe('full');
    expect(r.unlockedPages).toBeGreaterThan(3);
    expect(lockedDuringBulk.every((h) => h === false)).toBe(true);
    expect(x.locks.count).toBe(1);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
    // The ordinary push carries on from the backup's cursor: nothing to send.
    const sm2 = x.sm;
    await sm2.addWalletStorageProvider(x.backup);
    const before = await rows(x.backup);
    await sm2.updateBackups();
    expect(await rows(x.backup)).toEqual(before);
  });

  test('a payment’s writes during the bulk pass are not lost (a row already sent changes, a new one arrives)', async () => {
    const x = await setup(10);
    let n = 0;
    await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 3,
      pageGapMs: 0,
      afterPage: async () => {
        // Once the backup holds a coin: that coin is spent here, and new rows are made.
        const sent = await x.backup.findOutputs({ partial: {} });
        if (n || !sent.length) return;
        n++;
        const [first] = await x.dev.findOutputs({ partial: { txid: sent[0].txid, vout: sent[0].vout } });
        await x.dev.updateOutput(first.outputId, { spendable: false });
        await receive(x.wallet, x.kd, 7777);
      },
    });
    expect(n).toBe(1);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('a device restored from our snapshot starts at the restore point: older rows are not sent again', async () => {
    const x = await setup(6);
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await receive(x.wallet, x.kd, 4242);
    const r = await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, restorePoint, marginMs: 0 });
    expect(r.how).toBe('restore-point');
    expect(r.lockedMs).toHaveLength(1);
    expect((await x.backup.findTransactions({ partial: {} })).map((t) => t.txid)).toEqual([fresh]);
  });

  test('1p checks, 21 Nov 2026: the restore-point pass stays inside the real server’s RPC limits', async () => {
    // storage.bwalletx.com (toolbox StorageServer) refuses any list offset over 1,000,000 ("RPC list offsets must not
    // exceed 1000000"): the refs-only pass sent MAX_SAFE_INTEGER, so a restored device never filled our server, and
    // a coin it found spent never reached it.
    const x = await setup(3);
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await receive(x.wallet, x.kd, 4343);
    const real = x.backup.processSyncChunk.bind(x.backup);
    const writer = Object.assign(Object.create(x.backup), {
      processSyncChunk: async (args: { offsets: { offset: number }[] }, chunk: never) => {
        if (args.offsets.some((o) => o.offset > 1_000_000)) throw new Error('RPC list offsets must not exceed 1000000');
        return real(args as never, chunk);
      },
    });
    const r = await fillBackup({ manager: x.manager, reader: x.dev, writer, restorePoint, marginMs: 0 });
    expect(r.how).toBe('restore-point');
    expect((await x.backup.findTransactions({ partial: {} })).map((t) => t.txid)).toEqual([fresh]);
  });

  test('1p checks, 21 Nov 2026: fill pages are push pages, so they carry the rows they are filed under', async () => {
    // A coin marked spent after an instant restore has a transaction row older than the restore point: the page must
    // carry that parent (services/pushParents.ts treats only includeNextCheckpoint pages as pushes), or our server
    // can't file the coin ("Undefined binding(s)… transactionId") and the push never lands. The refs-only pass (baskets,
    // tags, labels: no parents) reads those three tables directly, never through getSyncChunk (review of 30a4fbcd, 6).
    const x = await setup(2);
    const asked: { push: unknown; pastEnd: boolean }[] = [];
    const reader = Object.assign(Object.create(x.dev), {
      getSyncChunk: (args: { includeNextCheckpoint?: unknown; offsets: { name: string; offset: number }[] }) => (
        asked.push({
          push: args.includeNextCheckpoint,
          pastEnd: args.offsets.some((o) => o.offset === Number.MAX_SAFE_INTEGER),
        }),
        x.dev.getSyncChunk(args as never)
      ),
    });
    // The app's push pages carry their parents (inboundSync's guard): a row a late wallet task touched after the
    // restore point then files under its transaction (the gates under load caught it without one, 22 Nov 2026).
    await new Promise((r) => setTimeout(r, 20));
    const unguard = installInboundSyncGuard(StorageIdb);
    await fillBackup({ manager: x.manager, reader, writer: x.backup, restorePoint: new Date(), marginMs: 0 }).finally(
      unguard,
    );
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.push === true && !a.pastEnd)).toBe(true);
    // The baskets still reached the backup (the restore pass files rows under them).
    expect((await x.backup.findOutputBaskets({ partial: {} })).map((b) => b.name)).toContain('default');
  });

  test('nothing new since the restore point: the two-pass fill instead (never a from-the-start push in the locks)', async () => {
    const x = await setup(4);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      restorePoint: new Date(Date.now() + 60_000),
      marginMs: 0,
    });
    expect(r.how).toBe('full');
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('a backup that already has a cursor for this device: not needed', async () => {
    const x = await setup(3);
    await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup });
    expect((await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup })).how).toBe('not-needed');
  });
});

/** A writer that refuses to loop: past `max` pages the test fails instead of hanging. */
const bounded = (backup: StorageIdb, max = 60, hook?: (n: number, args: never) => void) => {
  let n = 0;
  const real = backup.processSyncChunk.bind(backup);
  const calls: { offsets: { name: string; offset: number }[] }[] = [];
  const writer = Object.assign(Object.create(backup), {
    processSyncChunk: async (args: never, chunk: never) => {
      if (++n > max) throw new Error('LOOP: the fill kept sending pages');
      calls.push(JSON.parse(JSON.stringify(args)));
      hook?.(n, args);
      return real(args, chunk);
    },
  });
  return { writer, calls, pages: () => n };
};
const sum = (o: { offset: number }[]) => o.reduce((a, x) => a + x.offset, 0);

describe('mainnet 1p test, 22 Nov 2026: a fill that can’t finish stops, says so, and goes on later', () => {
  test('root cause: the refs-only pass, read as a push page, re-read every row from 0 and its offsets stopped moving', async () => {
    // Wallet B after an instant restore: a payment sent after the restore point, then the restore-point fill, with the
    // app's push pages (inboundSync's guard, as initWallet installs it). The refs-only pass went as a push page; its
    // MAX_SAFE_INTEGER offsets looked like a lost pass record (pushParents readPushPage rebase), so every transaction and
    // coin was read from 0, and MAX_SAFE_INTEGER + n lost precision: the same one-coin page went again and again, never
    // "done", until storage.bwalletx.com answered 429.
    const unguard = installInboundSyncGuard(StorageIdb);
    try {
      const x = await setup(4);
      await new Promise((r) => setTimeout(r, 20));
      const restorePoint = new Date();
      await new Promise((r) => setTimeout(r, 20));
      const paid = await x.wallet.createAction({
        description: 'a payment',
        outputs: [
          {
            lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
            satoshis: 3000,
            outputDescription: 'to someone',
          },
        ],
        options: { acceptDelayedBroadcast: false },
      });
      const w = bounded(x.backup);
      const r = await fillBackup({ manager: x.manager, reader: x.dev, writer: w.writer, restorePoint, marginMs: 0 });
      expect(r.how).toBe('restore-point');
      expect(w.pages()).toBeLessThan(10);
      // The payment's change reached the backup (cf0b.1 and cf0b.2 never did on mainnet).
      const change = (await x.dev.findOutputs({ partial: { txid: paid.txid! } })).filter((o) => o.change);
      expect(change.length).toBeGreaterThan(0);
      const held = await x.backup.findOutputs({ partial: { txid: paid.txid! } });
      for (const c of change) expect(held.some((o) => o.vout === c.vout)).toBe(true);
    } finally {
      unguard();
    }
  });

  const fakeReader = (pages: (n: number) => Record<string, unknown>, counts?: number) => {
    let n = 0;
    const reader: Record<string, unknown> = {
      getSettings: () => ({ storageIdentityKey: 'dev-sik' }),
      getSyncChunk: async () => pages(++n),
    };
    if (counts !== undefined)
      for (const c of [
        'ProvenTxs',
        'OutputBaskets',
        'OutputTags',
        'TxLabels',
        'Transactions',
        'Outputs',
        'TxLabelMaps',
        'OutputTagMaps',
        'Certificates',
        'CertificateFields',
        'Commissions',
        'ProvenTxReqs',
      ])
        reader[`count${c}`] = async () => counts;
    return { reader: reader as never, read: () => n };
  };
  const neverDone = (max = 100) => {
    let n = 0;
    return {
      writer: {
        makeAvailable: async () => ({ storageIdentityKey: 'server-sik' }),
        processSyncChunk: async () => {
          if (++n > max) throw new Error('LOOP: the fill kept sending pages');
          return { done: false };
        },
      } as never,
      pages: () => n,
    };
  };
  const manager = {
    getAuth: async () => ({ identityKey: '02ab', userId: 1 }),
    loadSyncRequest: async () => ({
      identityKey: '02ab',
      fromStorageIdentityKey: 'dev-sik',
      toStorageIdentityKey: 'server-sik',
    }),
    runAsSync: async <T>(fn: (a: unknown) => Promise<T>) => fn(undefined),
  };
  const ENTITY_KEYS = ['provenTxs', 'outputBaskets', 'outputTags', 'txLabels', 'transactions', 'outputs'];
  const page = (rows: Record<string, unknown[]>) =>
    Object.fromEntries([...ENTITY_KEYS.map((k) => [k, rows[k] ?? []]), ['txLabelMaps', undefined]]);

  test('(a) a page that moves no offset, never "done": stopped at once, not resent', async () => {
    const w = neverDone();
    const r = fakeReader(() => page({}));
    const e = await fillBackup({ manager, reader: r.reader, writer: w.writer }).catch((x) => x);
    expect(e).toBeInstanceOf(FillIncompleteError);
    expect((e as FillIncompleteError).kind).toBe('stalled');
    expect(w.pages()).toBe(1);
  });

  test('(a) the same rows twice (the cursor not really moving): stopped on the second', async () => {
    const w = neverDone();
    const at = new Date(Date.UTC(2026, 10, 22));
    const r = fakeReader(() => page({ outputs: [{ outputId: 9, vout: 1, updated_at: at, lockingScript: [1, 2] }] }));
    const e = await fillBackup({ manager, reader: r.reader, writer: w.writer }).catch((x) => x);
    expect((e as FillIncompleteError).kind).toBe('stalled');
    expect(w.pages()).toBe(2);
  });

  test('(a) a hard cap from the data: no more than 2 pages per row the device holds (plus 20)', async () => {
    const w = neverDone(1000);
    // A new row every page, forever: no page repeats, but the device holds only 12 × 1 rows.
    const r = fakeReader((n) => page({ outputs: [{ outputId: n, updated_at: new Date(n) }] }), 1);
    const e = await fillBackup({ manager, reader: r.reader, writer: w.writer, pageGapMs: 0 }).catch((x) => x);
    expect((e as FillIncompleteError).kind).toBe('stalled');
    expect(w.pages()).toBeLessThanOrEqual(20 + 2 * 12 + 1);
  });

  test('(b, d) a 429 ends the fill at once with its Retry-After; the next fill goes on from the last acknowledged page', async () => {
    const x = await setup(12);
    let saved: FillProgress | null | undefined;
    const progress: (FillProgress | null)[] = [];
    const onProgress = (p: FillProgress | null) => {
      saved = p;
      progress.push(p);
    };
    let refusedAt: { name: string; offset: number }[] | undefined;
    const first = bounded(x.backup, 60, (n, args: { offsets: { name: string; offset: number }[] }) => {
      if (n !== 4) return;
      refusedAt = args.offsets;
      throw Object.assign(new Error('WalletStorageClient rpcCall: network error 429'), { retryAfterMs: 42_000 });
    });
    const e = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: first.writer,
      maxItems: 3,
      pageGapMs: 0,
      onProgress,
    }).catch((err) => err);
    expect(e).toBeInstanceOf(FillIncompleteError);
    expect((e as FillIncompleteError).kind).toBe('refused');
    expect((e as FillIncompleteError).retryAfterMs).toBe(42_000);
    // Never a resend: the refused page was the last request.
    expect(first.pages()).toBe(4);
    // (d) Only acknowledged pages count: the kept progress is where the refused page started, not past it.
    expect(saved?.stage).toBe('bulk');
    expect(saved?.offsets).toEqual(refusedAt);
    expect(sum(saved!.offsets)).toBeGreaterThan(0);

    const second = bounded(x.backup);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: second.writer,
      maxItems: 3,
      pageGapMs: 0,
      resume: saved,
      onProgress,
    });
    expect(r.how).toBe('full');
    // From where it stopped: the first page of the second fill is the refused one.
    expect(second.calls[0].offsets).toEqual(refusedAt!);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
    expect(progress.at(-1)).toBeNull();
  });

  test('(b) progress the server’s checkpoint doesn’t hold (a page taken but its answer lost): that pass starts again', async () => {
    const x = await setup(6);
    const bogus: FillProgress = {
      stage: 'bulk',
      finalSince: Date.now() - 60_000,
      offsets: [
        'provenTx',
        'outputBasket',
        'outputTag',
        'txLabel',
        'transaction',
        'output',
        'txLabelMap',
        'outputTagMap',
        'certificate',
        'certificateField',
        'commission',
        'provenTxReq',
      ].map((name) => ({
        name,
        offset: 2,
      })),
    };
    const w = bounded(x.backup);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: w.writer,
      maxItems: 3,
      pageGapMs: 0,
      resume: bogus,
    });
    expect(r.how).toBe('full');
    expect(sum(w.calls[0].offsets)).toBe(0);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });
});

describe('review of 30a4fbcd / bcd8129b: a resumed or retried fill never leaves a change behind', () => {
  const pay = (x: Awaited<ReturnType<typeof setup>>) =>
    x.wallet.createAction({
      description: 'a payment',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
          satoshis: 3000,
          outputDescription: 'to someone',
        },
      ],
      options: { acceptDelayedBroadcast: false },
    });
  const writerWith = (
    backup: StorageIdb,
    hook: (args: { since?: unknown; offsets: { name: string; offset: number }[] }) => void,
  ) =>
    Object.assign(Object.create(backup), {
      processSyncChunk: async (args: never, chunk: never) => {
        hook(args);
        return backup.processSyncChunk(args, chunk);
      },
    });

  test('1 (repro A): a final pass refused part-way starts again from its since: a coin spent between tries reaches the backup', async () => {
    // Passes with a `since` count offsets among the rows changed since: a row behind the kept offset that changes
    // between tries moves in the set ahead of it and was never sent, and the backup's cursor then jumped past it.
    const x = await setup(12);
    let saved: FillProgress | null = null;
    let refused = false;
    const w1 = writerWith(x.backup, (args) => {
      const out = args.offsets.find((o) => o.name === 'output')!.offset;
      if (!refused && args.since != null && out >= 3) {
        refused = true;
        throw Object.assign(new Error('WalletStorageClient rpcCall: network error 429'), { retryAfterMs: 1000 });
      }
    });
    const e = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: w1,
      maxItems: 3,
      marginMs: 600_000,
      pageGapMs: 0,
      onProgress: (p) => void (saved = p),
    }).catch((err) => err);
    expect(e).toBeInstanceOf(FillIncompleteError);
    expect(saved!.stage).toBe('final');
    // Between tries (locks free): an old coin is spent, then a newer row changes.
    const outs = (await x.dev.findOutputs({ partial: {} })).sort((a, b) => a.outputId - b.outputId);
    await x.dev.updateOutput(outs[0].outputId, { spendable: false, updated_at: new Date() } as never);
    await new Promise((r) => setTimeout(r, 5));
    await x.dev.updateOutput(outs.at(-1)!.outputId, { outputDescription: 'later', updated_at: new Date() } as never);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 3,
      marginMs: 600_000,
      pageGapMs: 0,
      resume: saved,
    });
    expect(r.how).toBe('full');
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
    // And the ordinary push from the backup's cursor (once registered) finds nothing left behind.
    await x.sm.addWalletStorageProvider(x.backup);
    await x.sm.updateBackups();
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('2 (repro B): a stall after the refs-only pass finished: the next try fills, never "not-needed"', async () => {
    // The app's push pages carry their rows' parents (inboundSync's guard, as initWallet installs it).
    const unguard = installInboundSyncGuard(StorageIdb);
    try {
      const x = await setup(4);
      await new Promise((r) => setTimeout(r, 20));
      const restorePoint = new Date();
      await new Promise((r) => setTimeout(r, 20));
      const paid = await pay(x);
      const w1 = writerWith(x.backup, (args) => {
        if (args.since != null) throw new FillIncompleteError('stalled', 'simulated stall in the restore pass');
      });
      const e = await fillBackup({ manager: x.manager, reader: x.dev, writer: w1, restorePoint, marginMs: 0 }).catch(
        (err) => err,
      );
      expect((e as FillIncompleteError).kind).toBe('stalled');
      // The backup now has a cursor (the refs-only pass said done), but the fill is known unfinished.
      for (const resume of [null, { stage: 'restart', offsets: [] } as FillProgress]) {
        const r = await fillBackup({
          manager: x.manager,
          reader: x.dev,
          writer: x.backup,
          restorePoint,
          marginMs: 0,
          resume,
        });
        expect(r.how).not.toBe('not-needed');
      }
      const change = (await x.dev.findOutputs({ partial: { txid: paid.txid! } })).filter((o) => o.change);
      const held = await x.backup.findOutputs({ partial: { txid: paid.txid! } });
      for (const c of change) expect(held.some((o) => o.vout === c.vout)).toBe(true);
    } finally {
      unguard();
    }
  }, 30_000); // wallet setup plus three fills: the 5 s default timed out in a loaded full-suite run

  test('2: a fill known unfinished (no progress kept) never returns "not-needed" on the backup’s cursor', async () => {
    const x = await setup(3);
    await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, pageGapMs: 0 });
    const r = await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, pageGapMs: 0, unfinished: true });
    expect(r.how).toBe('full');
  });

  test('2: a final pass kept while the server lost its cursor: the fill starts from scratch', async () => {
    const x = await setup(5);
    const kept: FillProgress = {
      stage: 'final',
      since: Date.now() + 60_000,
      offsets: ['provenTx', 'outputBasket', 'outputTag', 'txLabel', 'transaction', 'output'].map((name) => ({
        name,
        offset: 0,
      })),
    };
    const r = await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, pageGapMs: 0, resume: kept });
    expect(r.how).toBe('full');
    expect(r.unlockedPages).toBeGreaterThan(0);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('3: a closed wallet stops the fill between pages', async () => {
    const x = await setup(6);
    let stop = false;
    const w = bounded(x.backup, 60, (n) => {
      if (n === 2) stop = true;
    });
    const e = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: w.writer,
      maxItems: 2,
      pageGapMs: 0,
      stopped: () => stop,
    }).catch((err) => err);
    expect(e).toBeInstanceOf(FillIncompleteError);
    expect(w.pages()).toBe(2);
  });

  test('4: the bulk pass is paced (at least 300 ms between pages), so a big wallet never bursts into the 300/min limit', async () => {
    const x = await setup(12);
    const sleeps: number[] = [];
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 3,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.unlockedPages).toBeGreaterThan(3);
    // A pause of 300 ms or more after every bulk page that wasn't the last.
    expect(sleeps.filter((ms) => ms >= 300).length).toBeGreaterThanOrEqual(r.unlockedPages);
  });

  test('6: the refs-only pass reads no transactions, coins or proofs (no MAX_SAFE_INTEGER walk inside the locks)', async () => {
    const x = await setup(3);
    const touched: string[] = [];
    const reader = new Proxy(x.dev, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => {
          const args = a[0] as { offsets?: { offset: number }[] } | undefined;
          if (p === 'getSyncChunk' && args?.offsets?.some((o) => o.offset === Number.MAX_SAFE_INTEGER))
            touched.push('getSyncChunk past the end');
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await fillBackup({ manager: x.manager, reader, writer: x.backup, restorePoint, marginMs: 0, pageGapMs: 0 });
    expect(touched).toEqual([]);
  });
});

describe('review of 82bdb7e3: every pass shares the fill’s pace; a backup that lost its state gets the whole fill', () => {
  test('2: refs, restore and final pages are paced like bulk ones (one budget, at least 400 ms apart)', async () => {
    const x = await setup(8);
    const clock = { t: Date.now() };
    const sentAt: number[] = [];
    const writer = Object.assign(Object.create(x.backup), {
      processSyncChunk: async (args: never, chunk: never) => (
        sentAt.push(clock.t),
        x.backup.processSyncChunk(args, chunk)
      ),
    });
    // A restore point 10 min back: the refs-only pass, then a restore pass over every row, all inside the locks.
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer,
      maxItems: 3,
      restorePoint: new Date(),
      marginMs: 600_000,
      now: () => clock.t,
      sleep: async (ms) => void (clock.t += ms),
    });
    expect(r.how).toBe('restore-point');
    expect(r.unlockedPages).toBe(0);
    expect(sentAt.length).toBeGreaterThan(4);
    for (let i = 1; i < sentAt.length; i++) expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(400);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  for (const stage of ['refs', 'restore', 'restart'] as const)
    test(`3: a kept ${stage} stage on a backup with no cursor (it lost its state): the whole two-pass fill`, async () => {
      const x = await setup(5);
      await new Promise((r) => setTimeout(r, 20));
      const restorePoint = new Date();
      await new Promise((r) => setTimeout(r, 20));
      // A coin changed after the restore point: a restore pass alone would land and leave the backup without the rest.
      const [coin] = await x.dev.findOutputs({ partial: {} });
      await x.dev.updateOutput(coin.outputId, { outputDescription: 'changed', updated_at: new Date() } as never);
      const kept: FillProgress = {
        stage,
        since: restorePoint.getTime(),
        offsets: ['provenTx', 'outputBasket', 'outputTag', 'txLabel'].map((name) => ({ name, offset: 0 })),
      };
      const unguard = installInboundSyncGuard(StorageIdb);
      const r = await fillBackup({
        manager: x.manager,
        reader: x.dev,
        writer: x.backup,
        restorePoint,
        marginMs: 0,
        pageGapMs: 0,
        resume: kept,
      }).finally(unguard);
      // Never a pass from the restore point alone: the backup holds none of the rows from before it.
      expect(r.how).toBe('full');
      expect(r.unlockedPages).toBeGreaterThan(0);
      expect(await rows(x.backup)).toEqual(await rows(x.dev));
    });
});

describe('repair of a backup an older build registered half-filled', () => {
  test('a full restart marker runs the whole two-pass fill, never a restore-point pass alone', async () => {
    const x = await setup(5);
    // Our server has a cursor (an older build's fill answered "not-needed" on it) but lacks rows.
    await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, pageGapMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const [coin] = await x.dev.findOutputs({ partial: {} });
    await x.dev.updateOutput(coin.outputId, { outputDescription: 'changed', updated_at: new Date() } as never);
    const unguard = installInboundSyncGuard(StorageIdb);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      restorePoint,
      marginMs: 0,
      pageGapMs: 0,
      resume: { stage: 'restart', offsets: [], full: true },
    }).finally(unguard);
    expect(r.how).toBe('full');
    expect(r.unlockedPages).toBeGreaterThan(0);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });
});

describe('review of 0c74701d, 6: the repair from a half-filled backup', () => {
  test('rows missing on our server (a non-default basket, a coin spent here still spendable there) all arrive', async () => {
    const x = await setup(4);
    // Our server as an older build left it: filled once, then never told of what follows.
    await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, pageGapMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await new Promise((r) => setTimeout(r, 20));
    // A token into a basket of its own.
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: Utils.toHex(Random(32)),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1 });
    const txid = tx.id('hex');
    tx.merklePath = new MerklePath(++height, [[{ offset: 0, hash: txid, txid: true }]]);
    const beef = new Beef();
    beef.mergeTransaction(tx);
    await x.wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'tokens' } }],
      description: 'a token',
    });
    // A coin spent here (our server still has it spendable).
    const [coin] = await x.dev.findOutputs({ partial: { spendable: true } });
    await x.dev.updateOutput(coin.outputId, { spendable: false, updated_at: new Date() } as never);
    const baskets = async (s: StorageIdb) => {
      const names = new Map((await s.findOutputBaskets({ partial: {} })).map((b) => [b.basketId, b.name]));
      return (await s.findOutputs({ partial: {} }))
        .map((o) => `${o.txid}.${o.vout}:${o.spendable}:${names.get(o.basketId!) ?? '-'}`)
        .sort();
    };
    // Half-filled: the backup differs from the device.
    expect(await baskets(x.backup)).not.toEqual(await baskets(x.dev));
    // The repair's fill: whole, from a restart marker, even with a restore point and our server's cursor.
    const unguard = installInboundSyncGuard(StorageIdb);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      restorePoint,
      marginMs: 0,
      pageGapMs: 0,
      resume: { stage: 'restart', offsets: [] },
      full: true,
      unfinished: true,
    }).finally(unguard);
    expect(r.how).toBe('full');
    expect(await baskets(x.backup)).toEqual(await baskets(x.dev));
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });
});
