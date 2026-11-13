/**
 * Sync can't half-arrive (balance integrity plan, fix 3; owner's phone, Nov 2026: an incremental pull merged two
 * completed transactions WITHOUT their output rows, and two BRC-29 change coins were missing until "Find missing
 * coins" copied them from the backup). services/pullIntegrity.ts.
 *
 * Real wallet-toolbox: StorageIdb stores on fake-indexeddb, a WalletStorageManager, the inbound guard as initWallet
 * installs it, the device-sync pull as initWallet runs it (requestFullPass, then syncFromReader in slices, then
 * afterPull). The backup is a StorageIdb served through a stand-in for the StorageClient (pages as small as asked,
 * failures on cue). No network.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import * as IS from '../services/inboundSync';
import {
  DEEP_PULL_EVERY_MS,
  STUCK_PASS_MS,
  _setFullPassSlice,
  markOf,
  passUnderWay,
  requestFullPass,
  syncStateFor,
  updateMark,
  withFullPassMode,
  type SyncStateRow,
} from '../services/fullPass';
import {
  EMPTY_OK_DAYS,
  MAX_EMPTY_OK,
  MAX_HEAL_TRIES,
  afterPull,
  emptyOkOf,
  emptyOkRecord,
  type IntegrityReport,
} from '../services/pullIntegrity';

const T = 120_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => 971_005 }),
    getHeight: async () => 971_005,
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

let dbn = 0;
async function idb(name: string) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `halfarrived-${name}-${++dbn}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
}

const hex32 = () => Utils.toHex(Random(32));
async function basketOf(b: StorageIdb, userId: number) {
  const had = (await b.findOutputBaskets({ partial: { userId, name: 'synthetic' } }))[0];
  if (had) return had.basketId;
  return b.insertOutputBasket({
    userId,
    name: 'synthetic',
    numberOfDesiredUTXOs: 0,
    minimumDesiredUTXOValue: 0,
    isDeleted: false,
  } as never);
}

/**
 * A payment straight into the backup's tables: `outs` coins, each spendable, written `age` ms ago (a copy that pushed
 * late carries its own old times). Returns its txid, the backup's transaction id and the coins' sats.
 */
async function payment(b: StorageIdb, identityKey: string, age: number, sats: number[], rows = sats.length) {
  const { user } = await b.findOrInsertUser(identityKey);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: hex32(),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  for (const s of sats)
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: s });
  const at = new Date(Date.now() - age);
  const txid = tx.id('hex');
  const transactionId = await b.insertTransaction({
    userId: user.userId,
    status: 'unproven',
    reference: Utils.toBase64(Random(12)),
    isOutgoing: true,
    satoshis: 0,
    description: 'a payment from the other device',
    version: 1,
    lockTime: 0,
    txid,
    rawTx: tx.toBinary(),
    created_at: at,
    updated_at: at,
  } as never);
  const basketId = await basketOf(b, user.userId);
  for (let v = 0; v < rows; v++) {
    const script = tx.outputs[v].lockingScript.toBinary();
    await b.insertOutput({
      userId: user.userId,
      transactionId,
      vout: v,
      satoshis: sats[v],
      spendable: true,
      change: false,
      type: 'custom',
      providedBy: 'you',
      purpose: '',
      outputDescription: 'coin',
      basketId,
      txid,
      lockingScript: script,
      scriptLength: script.length,
      created_at: at,
      updated_at: at,
    } as never);
  }
  return { txid, transactionId };
}

/** The other device's monitor saw it mined: the transaction row (only) is updated, with a time after this device's cursor. */
const mined = (b: StorageIdb, transactionId: number) =>
  b.updateTransaction(transactionId, { status: 'completed', updated_at: new Date() } as never);

/** wallet.1sat.app as this device's StorageClient sees it: pages of at most `maxItems` rows, failures on cue. */
function backupClient(b: StorageIdb) {
  const o: { maxItems?: number; failOnOutputs?: boolean; failAll?: boolean; pages: number } = { pages: 0 };
  const client = new Proxy(b, {
    get(t, p) {
      if (p === 'getSyncChunk')
        return async (args: Record<string, unknown>) => {
          if (o.failAll) throw new Error('network: the backup did not answer in time (getSyncChunk)');
          const c = (await t.getSyncChunk({
            ...args,
            ...(o.maxItems ? { maxItems: o.maxItems } : {}),
          } as never)) as unknown as Record<string, unknown[] | undefined>;
          // The connection drops on the first page that would bring coins: the pages before it (transactions) merged.
          if (o.failOnOutputs && c.outputs?.length)
            throw new Error('network: the backup did not answer in time (getSyncChunk)');
          o.pages++;
          return c;
        };
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { client, o };
}

async function device(txs = 6) {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const backup = await idb('backup');
  IS._mergeUnchecked(backup);
  const known = new Set<string>();
  for (let i = 0; i < txs; i++) {
    const p = await payment(backup, kd.identityKey, 0, [1_000 + i, 2_000 + i]);
    known.add(p.txid);
    await mined(backup, p.transactionId);
  }
  const phone = await idb('phone');
  const logs: string[] = [];
  const more = { n: 0 };
  const verifier: IS.InboundVerifier = {
    owns: IS.walletOwnership(root),
    readRecord: IS.walletRecords(root),
    spent: async () => ({ state: 'unspent' }) as never,
    txKnown: async (txid) => (known.has(txid) ? 'known' : 'unknown'),
    onMore: () => void more.n++,
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  };
  const off = IS.registerInboundVerifier(phone.getSettings().storageIdentityKey, kd.identityKey, verifier);
  const sm = new WalletStorageManager(kd.identityKey, phone, [backup]);
  await sm.makeAvailable();
  await sm.setActive(phone.getSettings().storageIdentityKey);
  sm.setServices(services);
  const { client, o } = backupClient(backup);
  const sik = phone.getSettings().storageIdentityKey;
  const backupSik = backup.getSettings().storageIdentityKey;
  const { user } = await backup.findOrInsertUser(kd.identityKey);
  const backupOutputs = async (id: number) =>
    (await backup.findOutputs({ partial: { userId: user.userId, transactionId: id }, noScript: true })) as never;
  const state = async () => (await syncStateFor(phone as never, kd.identityKey, backupSik))!;
  /** One device-sync pull as initWallet runs it, without the coin check (the code before this fix). */
  const pullOnly = async (now?: number) => {
    const plan = await requestFullPass({
      manager: sm as never,
      store: phone as never,
      identityKey: kd.identityKey,
      readerSik: backupSik,
      now,
    });
    await withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, client as never));
    return plan;
  };
  const check = (now?: number, extra: { backupOutputs?: typeof backupOutputs } = {}) =>
    afterPull({
      manager: sm as never,
      store: phone as never,
      identityKey: kd.identityKey,
      readerSik: backupSik,
      backupOutputs,
      now,
      log: (m) => logs.push(m),
      ...extra,
    });
  /** The whole device-sync pull (this fix): the pull, then the coin check. */
  const pull = async (now?: number) => {
    await pullOnly(now);
    return check(now);
  };
  /** Pull until nothing is under way (a pass from the start, deep, heal or incremental): the last check's report. */
  const pullToEnd = async (max = 500) => {
    let r: IntegrityReport | undefined;
    for (let i = 0; i < max; i++) {
      r = await pull();
      const st = await state();
      if (st.when != null && !passUnderWay(st) && r.plan !== 'healing' && r.plan !== 'busy') break;
    }
    return r!;
  };
  const pullOnlyToEnd = async (max = 500) => {
    for (let i = 0; i < max; i++) {
      await pullOnly();
      const st = await state();
      const m = markOf(st);
      if (st.when != null && !passUnderWay(st) && typeof m.deepStartedAt !== 'number') break;
    }
  };
  const admit = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await IS.admitPending(phone as never, kd.identityKey, verifier);
      if (!r.left || (!r.admitted && !r.refused)) break;
    }
  };
  const outputsOf = async (txid: string) => (await phone.findOutputs({ partial: { txid } })).length;
  /** Transactions this device holds with no coin rows at all. */
  const halfArrived = async () => {
    const outs = await phone.findOutputs({ partial: {}, noScript: true });
    const has = new Set(outs.map((r) => r.transactionId));
    return (await phone.findTransactions({ partial: {}, noRawTx: true })).filter((t) => !has.has(t.transactionId))
      .length;
  };
  /** Spendable sats, as a balance: this device's after admission, the backup's as it holds them. */
  const balance = async (s: StorageIdb) =>
    (await s.findOutputs({ partial: { spendable: true }, noScript: true })).reduce((n, r) => n + r.satoshis, 0);
  return {
    kd,
    backup,
    phone,
    sm,
    o,
    logs,
    more,
    known,
    off,
    state,
    pull,
    pullOnly,
    pullToEnd,
    pullOnlyToEnd,
    check,
    admit,
    outputsOf,
    halfArrived,
    balance,
    backupSik,
  };
}

let uninstall = () => undefined as void;
beforeAll(() => {
  uninstall = IS.installInboundSyncGuard(StorageIdb);
});
afterEach(() => _setFullPassSlice());
afterAll(() => {
  uninstall();
  IS._resetInboundVerifiers();
});

describe('a pull that brings a payment without its coins heals itself (fix 3)', () => {
  test(
    "the phone's shape: coins written before the cursor, the payment mined after it: the row arrives alone, then its coins",
    async () => {
      const d = await device();
      try {
        await d.pullToEnd();
        await d.admit();
        expect(await d.halfArrived()).toBe(0);
        // The other device wrote a payment with two change coins 3 h ago and pushed it late (past the 15-minute
        // overlap); then its monitor saw it mined and pushed the transaction row with a fresh time.
        const late = await payment(d.backup, d.kd.identityKey, 3 * HOUR, [70_000, 30_000]);
        d.known.add(late.txid);
        await mined(d.backup, late.transactionId);

        // Before this fix: the incremental pull takes the transaction (newer than the cursor) and not its coins (older),
        // and no later incremental pull ever sends them.
        await d.pullOnlyToEnd();
        expect((await d.phone.findTransactions({ partial: { txid: late.txid }, noRawTx: true })).length).toBe(1);
        expect(await d.outputsOf(late.txid)).toBe(0);
        await d.pullOnlyToEnd();
        expect(await d.outputsOf(late.txid)).toBe(0);
        expect(markOf(await d.state()).awaitOutputs).toBeDefined(); // the guard noted it

        // The coin check after the pull: the backup holds 2 coins for it that this device lacks → a heal pass.
        const r = await d.check();
        expect(r.plan).toBe('healing');
        expect(r.missingTx).toBe(1);
        expect(r.missingOutputs).toBe(2);
        expect(typeof markOf(await d.state()).healStartedAt).toBe('number');
        const end = await d.pullToEnd();
        expect(await d.outputsOf(late.txid)).toBe(2);
        expect(end.awaiting).toBe(0);
        expect(markOf(await d.state()).healStartedAt).toBeUndefined();
        expect(typeof markOf(await d.state()).healDoneAt).toBe('number');
        // Through the inbound check like any row: not spendable until the chain says so, then the balance matches.
        await d.admit();
        expect(await d.halfArrived()).toBe(0);
        expect(await d.balance(d.phone)).toBe(await d.balance(d.backup));
        // The cursor is back at the newest time seen: the next pulls are ordinary incremental ones.
        expect((await d.pull()).plan).toBe('none');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'a pull interrupted between the transaction pages and the coin pages, its pass then given up: after the next pulls the coins are there',
    async () => {
      const d = await device();
      try {
        await d.pullToEnd();
        await d.admit();
        // Three payments pushed 3 h late (inside the daily deep pull's 48 h, outside the 15-minute overlap).
        const late = [];
        for (const sats of [
          [11_000, 12_000],
          [21_000, 22_000],
          [31_000, 32_000],
        ]) {
          const p = await payment(d.backup, d.kd.identityKey, 3 * HOUR, sats);
          d.known.add(p.txid);
          late.push(p);
        }
        // The daily deep pull, in pages of 3 rows; the connection drops at the first page with coins.
        d.o.maxItems = 3;
        d.o.failOnOutputs = true;
        const t0 = Date.now() + DEEP_PULL_EVERY_MS + 1;
        expect(await d.pullOnly(t0).catch(() => 'failed')).toBe('failed'); // 'deep', then the page fails
        expect(typeof markOf(await d.state()).deepStartedAt).toBe('number');
        for (let i = 0; i < 3; i++) await d.pullOnly(t0 + i).catch(() => undefined);
        const merged = await Promise.all(late.map((p) => d.phone.findTransactions({ partial: { txid: p.txid } })));
        expect(merged.filter((x) => x.length).length).toBeGreaterThan(0); // transaction pages merged
        expect((await Promise.all(late.map((p) => d.outputsOf(p.txid)))).every((n) => n === 0)).toBe(true);
        expect(await d.halfArrived()).toBeGreaterThan(0);

        // Its offsets stop moving for 30 min of uptime: the deep pull is given up, the cursor back where it was.
        const before = markOf(await d.state()).deepFromWhen;
        expect(typeof before).toBe('number');
        let plan = '';
        for (let t = t0 + 5 * MIN; plan !== 'abandoned' && t < t0 + 2 * HOUR; t += 5 * MIN)
          plan = await requestFullPass({
            manager: d.sm as never,
            store: d.phone as never,
            identityKey: d.kd.identityKey,
            readerSik: d.backupSik,
            now: t,
          });
        expect(plan).toBe('abandoned');
        const st = await d.state();
        expect(new Date(st.when as string).getTime()).toBe(before!);
        expect(passUnderWay(st)).toBe(false);
        expect(markOf(st).deepStartedAt).toBeUndefined();

        // The connection is back. Before this fix the ordinary pulls never send those coins again (older than the
        // cursor), so the payments stayed without them.
        d.o.failOnOutputs = false;
        await d.pullOnlyToEnd();
        expect(await d.halfArrived()).toBeGreaterThan(0);
        // With the coin check: healed in slices of the same small pages.
        const r = await d.check();
        expect(r.plan).toBe('healing');
        await d.pullToEnd();
        for (const p of late) {
          if ((await d.phone.findTransactions({ partial: { txid: p.txid } })).length)
            expect(await d.outputsOf(p.txid)).toBe(2);
        }
        expect(await d.halfArrived()).toBe(0);
        await d.admit();
        // The payments the deep pull never reached come with the daily deep pull or the tail check; the ones it
        // brought half-way are whole, and every coin this device holds is one the backup holds.
        const theirs = await d.balance(d.backup);
        const lateSats = (
          await Promise.all(
            late.map(async (p) =>
              (await d.phone.findTransactions({ partial: { txid: p.txid } })).length
                ? 0
                : (await d.backup.findOutputs({ partial: { transactionId: p.transactionId } })).reduce(
                    (n, o) => n + o.satoshis,
                    0,
                  ),
            ),
          )
        ).reduce((a, b) => a + b, 0);
        expect(await d.balance(d.phone)).toBe(theirs - lateSats);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'a page boundary between a transaction and its coins: a pull that stops there resumes from its checkpoint, nothing skipped',
    async () => {
      const d = await device();
      try {
        await d.pullToEnd();
        await d.admit();
        const late = await payment(d.backup, d.kd.identityKey, 0, [5_000, 6_000, 7_000]);
        d.known.add(late.txid);
        // Pages of 1 row: the transaction alone on one page, each coin on its own after it. Slices of 0 ms: every pull
        // ends after one page (the checkpoint has it), as a pull cut short by a payment or the slice clock does.
        d.o.maxItems = 1;
        _setFullPassSlice(0);
        let r = await d.pull();
        let pulls = 1;
        const seen: number[] = [];
        while (r.plan === 'busy' && pulls < 50) {
          seen.push(await d.outputsOf(late.txid));
          r = await d.pull();
          pulls++;
        }
        expect(seen).toContain(0); // part-way, the transaction was here before its coins (the boundary)
        expect(await d.outputsOf(late.txid)).toBe(3); // and the pass carried on from its checkpoint to the end
        expect(r.awaiting).toBe(0); // the check found it whole
        expect(await d.halfArrived()).toBe(0);
        await d.admit();
        expect(await d.balance(d.phone)).toBe(await d.balance(d.backup));
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'a merge that fails part-way through a page takes none of it (the page is one IndexedDB transaction)',
    async () => {
      const d = await device();
      try {
        await d.pullToEnd();
        const late = await payment(d.backup, d.kd.identityKey, 0, [8_000, 9_000]);
        d.known.add(late.txid);
        // The page holds the transaction and both coins; the second coin's insert fails.
        const phone = d.phone as unknown as { insertOutput: (...a: unknown[]) => Promise<number> };
        const real = phone.insertOutput.bind(d.phone);
        let n = 0;
        phone.insertOutput = async (...a: unknown[]) => {
          if (++n === 2) throw new Error('disk full');
          return real(...a);
        };
        await expect(d.pullOnly()).rejects.toThrow();
        expect((await d.phone.findTransactions({ partial: { txid: late.txid } })).length).toBe(0);
        expect(await d.outputsOf(late.txid)).toBe(0);
        phone.insertOutput = real;
        await d.pullToEnd();
        expect(await d.outputsOf(late.txid)).toBe(2);
        expect(await d.halfArrived()).toBe(0);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'coins the heal passes never bring: after MAX_HEAL_TRIES the backup is pulled from the start; a completed full pass clears the list',
    async () => {
      const d = await device(3);
      try {
        await d.pullToEnd();
        // Two outputs, one row on the backup; it says it holds a second coin the pulls never send.
        const late = await payment(d.backup, d.kd.identityKey, 3 * HOUR, [4_000, 1_000], 1);
        d.known.add(late.txid);
        await mined(d.backup, late.transactionId);
        await d.pullOnlyToEnd();
        expect(await d.outputsOf(late.txid)).toBe(0);
        const { user } = await d.backup.findOrInsertUser(d.kd.identityKey);
        const lying = async (id: number) => [
          ...((await d.backup.findOutputs({ partial: { userId: user.userId, transactionId: id } })) as never[]),
          ...(id === late.transactionId ? [{ vout: 1, updated_at: new Date(Date.now() - HOUR) }] : []),
        ];
        const plans: string[] = [];
        for (let i = 0; i <= MAX_HEAL_TRIES; i++) {
          const r = await d.check(undefined, { backupOutputs: lying as never });
          plans.push(r.plan);
          if (r.plan === 'healing') await d.pullOnlyToEnd();
        }
        expect(plans).toEqual([...Array(MAX_HEAL_TRIES).fill('healing'), 'full-due']);
        expect(await d.outputsOf(late.txid)).toBe(1); // the real coin came with the first heal
        const mark = markOf(await d.state());
        expect(mark.due).toBe('incomplete');
        expect(mark.awaitOutputs?.[String(late.transactionId)]?.tries).toBe(MAX_HEAL_TRIES + 1);
        // Asked again only after GIVEN_UP_RETRY_MS, not on every pull.
        expect((await d.check(undefined, { backupOutputs: lying as never })).checked).toBe(0);
        // The next pull starts the full pass (an error-driven one: any network, at most one per 24 h).
        expect(await d.pullOnly()).toBe('started');
        await d.pullOnlyToEnd();
        const after = markOf(await d.state());
        expect(after.awaitOutputs).toBeUndefined();
        expect(after.due).toBeUndefined();
        expect(typeof after.doneAt).toBe('number');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'damage from before the check: a payment with no coins here at all is found by the daily scan and healed',
    async () => {
      const d = await device(3);
      try {
        await d.pullToEnd();
        const late = await payment(d.backup, d.kd.identityKey, 3 * HOUR, [50_000, 25_000]);
        d.known.add(late.txid);
        await mined(d.backup, late.transactionId);
        await d.pullOnlyToEnd();
        // As a device that merged it before this release would hold it: not noted, no coins.
        const st = await d.state();
        await updateMark(d.phone as never, st, { awaitOutputs: undefined, scanAt: undefined });
        expect(await d.outputsOf(late.txid)).toBe(0);
        const r = await d.check(); // the first check on a device updated to this release scans
        expect(r.plan).toBe('healing');
        await d.pullToEnd();
        expect(await d.outputsOf(late.txid)).toBe(2);
        await d.admit();
        expect(await d.balance(d.phone)).toBe(await d.balance(d.backup));
        // The next scan is a day away.
        expect(typeof markOf(await d.state()).scanAt).toBe('number');
      } finally {
        d.off();
      }
    },
    T,
  );
});

describe('review of 6737dd2c: the coin check stays out of the way', () => {
  test(
    'a payment the backup holds no coins for is remembered by day, re-asked after EMPTY_OK_DAYS; never more than MAX_EMPTY_OK',
    async () => {
      const d = await device(2);
      try {
        await d.pullToEnd();
        const bare = await payment(d.backup, d.kd.identityKey, 0, [1_000], 0); // a raw tx with an output, no rows
        d.known.add(bare.txid);
        const r = await d.pullToEnd();
        expect(r.awaiting).toBe(0);
        const day = Math.floor(Date.now() / 86_400_000);
        const kept = markOf(await d.state()).emptyOk as Record<string, number>;
        expect(kept[String(bare.transactionId)]).toBe(day);
        // The daily scan skips it while remembered, and asks again once EMPTY_OK_DAYS have passed.
        const asked: number[] = [];
        const counting = async (id: number) => {
          asked.push(id);
          return [];
        };
        await updateMark(d.phone as never, await d.state(), { scanAt: undefined });
        await d.check(Date.now() + 86_400_000, { backupOutputs: counting as never });
        expect(asked).toEqual([]);
        await updateMark(d.phone as never, await d.state(), { scanAt: undefined });
        await d.check(Date.now() + (EMPTY_OK_DAYS + 1) * 86_400_000, { backupOutputs: counting as never });
        expect(asked).toEqual([bare.transactionId]);
        // The list keeps the newest MAX_EMPTY_OK.
        const many = new Map(
          Array.from({ length: MAX_EMPTY_OK + 10 }, (_, i) => [String(1e6 + i), day - (i < 10 ? 5 : 0)]),
        );
        const stored = emptyOkRecord(many)!;
        expect(Object.keys(stored).length).toBe(MAX_EMPTY_OK);
        expect(stored[String(1e6)]).toBeUndefined(); // an older one went first
        expect(stored[String(1e6 + MAX_EMPTY_OK + 9)]).toBe(day);
        expect(emptyOkOf({ emptyOk: { '1': day - EMPTY_OK_DAYS } }, Date.now()).size).toBe(0);
        expect(emptyOkOf({ emptyOk: [7, 8] }, Date.now()).size).toBe(2); // the first form reads as checked today
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    "a Store payment's push waiting: the check stops and the daily scan is skipped; a slow backup never overruns the budget",
    async () => {
      const d = await device(2);
      try {
        await d.pullToEnd();
        const late = await payment(d.backup, d.kd.identityKey, 3 * HOUR, [9_000, 1_000], 1);
        d.known.add(late.txid);
        await mined(d.backup, late.transactionId);
        await d.pullOnlyToEnd();
        await updateMark(d.phone as never, await d.state(), { scanAt: undefined });
        const stopped = await afterPull({
          manager: d.sm as never,
          store: d.phone as never,
          identityKey: d.kd.identityKey,
          readerSik: d.backupSik,
          backupOutputs: async () => {
            throw new Error('not asked');
          },
          stop: () => true,
        });
        expect(stopped.checked).toBe(0);
        expect(markOf(await d.state()).scanAt).toBeUndefined(); // the scan waits for a pull with no push waiting
        // A backup that never answers: the check ends within its budget (no per-call floor past it).
        const t0 = Date.now();
        const slow = await afterPull({
          manager: d.sm as never,
          store: d.phone as never,
          identityKey: d.kd.identityKey,
          readerSik: d.backupSik,
          backupOutputs: () => new Promise(() => undefined),
          budgetMs: 300,
        });
        expect(Date.now() - t0).toBeLessThan(300 + 200);
        expect(slow.plan).not.toBe('healing');
        expect(markOf(await d.state()).awaitOutputs?.[String(late.transactionId)]?.nextAt).toBeGreaterThan(Date.now());
      } finally {
        d.off();
      }
    },
    T,
  );
});

describe('a stuck pull that is not from the start (5.2.54 gave up only those)', () => {
  test(
    'an incremental pass under way, unmoved for 30 min of uptime: reported as stuck, never given up (that would skip rows)',
    async () => {
      const d = await device(3);
      try {
        await d.pullToEnd();
        for (let i = 0; i < 4; i++) {
          const p = await payment(d.backup, d.kd.identityKey, 0, [100 + i]);
          d.known.add(p.txid);
        }
        // One page merges, then the backup stops answering: an incremental pass part-way.
        d.o.maxItems = 1;
        _setFullPassSlice(0);
        await d.pullOnly();
        const st0: SyncStateRow = await d.state();
        expect(passUnderWay(st0)).toBe(true);
        d.o.failAll = true;
        const t0 = Date.now();
        const plans: string[] = [];
        for (let t = t0; t <= t0 + STUCK_PASS_MS + 10 * MIN; t += 5 * MIN) {
          plans.push(
            await requestFullPass({
              manager: d.sm as never,
              store: d.phone as never,
              identityKey: d.kd.identityKey,
              readerSik: d.backupSik,
              now: t,
            }),
          );
          await d.pullOnly(t).catch(() => undefined);
        }
        expect(plans).toContain('stuck');
        expect(plans).not.toContain('abandoned');
        const st1 = await d.state();
        expect(st1.when).toEqual(st0.when); // the cursor and offsets kept: it resumes when the backup answers
        expect(passUnderWay(st1)).toBe(true);
        d.o.failAll = false;
        _setFullPassSlice();
        d.o.maxItems = undefined;
        await d.pullToEnd();
        expect(await d.halfArrived()).toBe(0);
        expect(passUnderWay(await d.state())).toBe(false);
      } finally {
        d.off();
      }
    },
    T,
  );
});
