/**
 * Fourth review 17d, M1: after a "Missing inputs" refusal only the coin the broadcaster names is set aside, never a
 * live one whose parent WhatsOnChain hasn't indexed yet; only plain default-basket change; every set-aside is recorded
 * (ORPHAN_MARK) and comes back by itself once its parent is seen. Runs the real healRefusedInputs and autoResyncCoins
 * over stubbed storage, services and WhatsOnChain (the reviewer's scratch orphan.test.ts, O1, is the first test).
 */
import { describe, expect, test } from 'bun:test';
import { MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { healRefusedInputs, ORPHAN_SECOND_LOOK_MS, type SendChecksContext } from './ownSend';
import { noteRefusals } from './broadcastRefusals';
import { AUTO_RESYNC_KEY, ORPHAN_MARK, autoResyncCoins } from './autoCoinResync';
import { classifySendError, MISSING_PARENT_MESSAGE } from '../utils/sendErrors';

const lock = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress());
const parent = (sats: number) => {
  const t = new Transaction();
  t.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: lock(),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: lock(), satoshis: sats });
  t.merklePath = new MerklePath(1, [[{ offset: 0, hash: t.id('hex'), txid: true }]]); // only so AtomicBEEF serialises
  return t;
};

type Row = {
  outputId: number;
  txid: string;
  vout: number;
  spendable: boolean;
  change: boolean;
  type: string;
  basketId: number;
};

/** A refused send spending `parents`' first outputs; storage holds one row per input, as `rows` says. */
function world(o: {
  parents: Transaction[];
  reason: (ids: string[]) => string;
  rows?: Partial<Row>[];
  status?: (string | undefined)[];
  chainSees?: Set<string>;
}) {
  const T = new Transaction();
  for (const p of o.parents)
    T.addInput({ sourceTransaction: p, sourceOutputIndex: 0, unlockingScript: lock(), sequence: 0xffffffff });
  T.addOutput({ lockingScript: lock(), satoshis: 1000 });
  const ids = o.parents.map((p) => p.id('hex'));
  const tTxid = T.id('hex');
  const rows: Row[] = ids.map((txid, i) => ({
    outputId: i + 1,
    txid,
    vout: 0,
    spendable: true,
    change: true,
    type: 'P2PKH',
    basketId: 1,
    ...(o.rows?.[i] ?? {}),
  }));
  const status = new Map(ids.map((id, i) => [id, o.status?.[i]]));
  const kvData: Record<string, unknown> = {};
  const kv = {
    get: async (k: string) => ({ [k]: structuredClone(kvData[k]) }),
    set: async (items: Record<string, unknown>) => void Object.assign(kvData, structuredClone(items)),
  };
  const chainSees = o.chainSees ?? new Set<string>();
  const storage = {
    runAsStorageProvider: async <R>(f: (sp: unknown) => Promise<R>) =>
      f({
        findUsers: async () => [{ userId: 1 }],
        findOutputBaskets: async ({ partial }: { partial: { name: string } }) =>
          partial.name === 'default' ? [{ basketId: 1 }] : [],
        findTransactions: async ({ partial }: { partial: { txid: string } }) => {
          const s = status.get(partial.txid);
          return s ? [{ status: s, provenTxId: null, txid: partial.txid }] : [];
        },
        findOutputs: async ({ partial }: { partial: { txid: string; vout: number; spendable?: boolean } }) =>
          rows.filter(
            (r) =>
              r.txid === partial.txid &&
              r.vout === partial.vout &&
              (partial.spendable === undefined || r.spendable === partial.spendable),
          ),
        updateOutput: async (id: number, u: { spendable: boolean }) => {
          const r = rows.find((x) => x.outputId === id);
          if (!r || r.spendable === u.spendable) return 0;
          r.spendable = u.spendable;
          return 1;
        },
      }),
  };
  const services = {
    txo: { getSpend: async () => null }, // no input is spent
    // The 1Sat stack calls a tx it didn't broadcast (or holds QUEUED/STORED/ANNOUNCED) "unknown".
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chainSees.has(txid) ? 'mined' : 'unknown' })),
    }),
  };
  // WhatsOnChain: /tx/hash 404 for anything not in chainSees; /spent 404.
  const fetch = (async (u: string) => {
    const m = /\/tx\/hash\/([0-9a-f]{64})/.exec(String(u));
    return m && chainSees.has(m[1])
      ? new Response(JSON.stringify({ txid: m[1] }), { status: 200 })
      : new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  let clock = 1_000_000;
  const c: SendChecksContext = {
    storage,
    services,
    identityKey: '02'.padEnd(66, 'a'),
    mainnet: true,
    kv: kv as never,
    fetch,
    now: () => clock,
  };
  const refuse = () => {
    noteRefusals([
      { status: 'error', error: new Error(o.reason(ids)), txidResults: [{ txid: tTxid, status: 'error' }] },
    ]);
    return healRefusedInputs(
      c,
      Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
        name: 'WERR_REVIEW_ACTIONS',
        reviewActionResults: [{ txid: tTxid, status: 'invalidTx' }],
        tx: T.toAtomicBEEF(),
      }),
    );
  };
  const recorded = () =>
    ((kvData[AUTO_RESYNC_KEY] as Record<string, { cleared?: Record<string, string> }> | undefined)?.[c.identityKey]
      ?.cleared ?? {}) as Record<string, string>;
  return { ids, rows, refuse, recorded, c, chainSees, tick: (ms: number) => void (clock += ms) };
}

describe('17d M1: "Missing inputs" sets aside only what it should', () => {
  test('O1 (reviewer): a live input is NOT set aside with the dead one the broadcaster names; the dead one is recorded', async () => {
    // dead: our payment the network dropped (its change is a phantom). live: our payment accepted a moment ago
    // ('unproven'), or a fresh receive, that WhatsOnChain hasn't indexed and the stack calls "unknown".
    const w = world({
      parents: [parent(1_000_000), parent(5_000_000)],
      reason: ([dead]) => `Missing inputs: ${dead}:0`,
      status: ['unproven', 'unproven'],
    });
    const heal = await w.refuse();
    expect(heal?.orphaned).toEqual([`${w.ids[0]}_0`]);
    expect(w.rows.map((r) => r.spendable)).toEqual([false, true]); // before the fix: [false, false]
    expect(w.recorded()).toEqual({ [`${w.ids[0]}_0`]: ORPHAN_MARK }); // before the fix: nothing recorded
  });

  test('a reason that names the parent txid only: just that input', async () => {
    const w = world({ parents: [parent(1000), parent(2000)], reason: ([, b]) => `ERROR: 16: Missing inputs (${b})` });
    expect((await w.refuse())?.orphaned).toEqual([`${w.ids[1]}_0`]);
  });

  test('the only input of the payment counts as named', async () => {
    const w = world({ parents: [parent(1000)], reason: () => 'Missing inputs' });
    expect((await w.refuse())?.orphaned).toEqual([`${w.ids[0]}_0`]);
  });

  test('nothing named, two inputs: set aside only on a second refusal at least 10 minutes later', async () => {
    const w = world({ parents: [parent(1000), parent(2000)], reason: () => 'Missing inputs' });
    expect((await w.refuse())?.orphaned).toBeUndefined(); // first look: noted only
    w.tick(ORPHAN_SECOND_LOOK_MS - 60_000);
    expect((await w.refuse())?.orphaned).toBeUndefined(); // too soon
    w.tick(60_000);
    expect((await w.refuse())?.orphaned?.sort()).toEqual([`${w.ids[0]}_0`, `${w.ids[1]}_0`].sort());
    expect(Object.values(w.recorded())).toEqual([ORPHAN_MARK, ORPHAN_MARK]);
  });

  test('nothing named: a parent that is our own payment going out or accepted (unproven) is never set aside', async () => {
    for (const s of ['unproven', 'sending', 'unprocessed', 'nosend']) {
      const w = world({ parents: [parent(1000), parent(2000)], reason: () => 'Missing inputs', status: [s, s] });
      await w.refuse();
      w.tick(ORPHAN_SECOND_LOOK_MS);
      expect((await w.refuse())?.orphaned).toBeUndefined();
      expect(w.rows.every((r) => r.spendable)).toBe(true);
    }
  });

  test('a parent the chain knows (WhatsOnChain or the stack) is never set aside, named or not', async () => {
    const p = parent(1000);
    const w = world({ parents: [p], reason: ([a]) => `Missing inputs: ${a}:0`, chainSees: new Set([p.id('hex')]) });
    expect((await w.refuse())?.orphaned).toBeUndefined();
    expect(w.rows[0].spendable).toBe(true);
  });

  test('module assets are never touched: ordinals, tokens, locks and OpNS (not default-basket P2PKH change)', async () => {
    for (const row of [{ change: false }, { type: 'custom' }, { basketId: 7 }]) {
      const w = world({ parents: [parent(1)], reason: ([a]) => `Missing inputs: ${a}:0`, rows: [row] });
      expect((await w.refuse())?.orphaned).toBeUndefined();
      expect(w.rows[0].spendable).toBe(true);
      expect(w.recorded()).toEqual({});
    }
  });

  test('the words: set aside for now, checked again; unknown whether it went out; never "won\'t use it again"', () => {
    expect(MISSING_PARENT_MESSAGE).toMatch(/set aside for now/);
    expect(MISSING_PARENT_MESSAGE).toMatch(/check again and put it back/);
    expect(MISSING_PARENT_MESSAGE).not.toMatch(/won't use it again|never reached/);
    expect(classifySendError(MISSING_PARENT_MESSAGE)).toMatchObject({
      message: MISSING_PARENT_MESSAGE,
      moneyMoved: 'unknown',
    });
  });
});

describe('17d M1: the automatic check puts a set-aside coin back once its parent shows up', () => {
  const deps = (cleared: Record<string, string>, seen: boolean | null, restoredTo: string[]) => ({
    coins: [],
    cleared,
    ownPendingTxids: new Set<string>(),
    ownPendingInputs: new Set<string>(),
    getSpends: async (b: string[]) => b.map(() => null), // an outpoint of a tx the chain lacks reads "unspent"
    woc: async () => null,
    markSpent: async () => 0,
    markUnspent: async (o: string) => (restoredTo.push(o), 1),
    txSeen: async () => seen,
  });
  const op = `${'ab'.repeat(32)}_0`;

  test('parent still unknown: stays set aside (never revived by "both sources say unspent")', async () => {
    const restored: string[] = [];
    for (const mode of ['full', 'light'] as const) {
      const r = await autoResyncCoins({ ...deps({ [op]: ORPHAN_MARK }, false, restored), mode });
      expect(r.cleared).toEqual({ [op]: ORPHAN_MARK });
    }
    expect(restored).toEqual([]);
  });

  test('parent seen on chain: the coin is restored and its record ends', async () => {
    const restored: string[] = [];
    const r = await autoResyncCoins({ ...deps({ [op]: ORPHAN_MARK }, true, restored), mode: 'light' });
    expect(restored).toEqual([op]);
    expect(r.restored).toBe(1);
    expect(r.cleared).toEqual({});
  });

  test("a lookup that can't tell keeps the record for the next run", async () => {
    const restored: string[] = [];
    const r = await autoResyncCoins({ ...deps({ [op]: ORPHAN_MARK }, null, restored), mode: 'light' });
    expect(restored).toEqual([]);
    expect(r.cleared).toEqual({ [op]: ORPHAN_MARK });
  });
});

/**
 * test/phone-1106 merge (sign-and-seal 5cd462ce onto the candidate line): after a refused broadcast the toolbox's own
 * stale-input check can set the input unspendable before this heal runs. The real healRefusedInputs counts it as
 * released (so the one guarded retry can run), but it is not "cleared" by us and never goes on the undo list.
 */
describe('UTXO_SPENT on a coin the toolbox already set unspendable (native seal, 3 Nov)', () => {
  const OTHER = 'e'.repeat(64);
  test('counted as released, reported alreadyOff, not cleared, not recorded for undo', async () => {
    const w = world({
      parents: [parent(1_000)],
      reason: ([id]) => `UTXO_SPENT (70): ${id}:0 utxo already spent by tx ${OTHER}[0]`,
      rows: [{ spendable: false }],
    });
    const heal = await w.refuse();
    expect(heal?.released).toBe(1);
    expect(heal?.cleared).toEqual([]);
    expect(heal?.alreadyOff).toEqual([`${w.ids[0]}_0`]);
    expect(heal?.spenders).toEqual({ [`${w.ids[0]}_0`]: OTHER });
    expect(w.recorded()).toEqual({});
  });
  test('a coin storage still lists as spendable is cleared and recorded, as before', async () => {
    const w = world({
      parents: [parent(1_000)],
      reason: ([id]) => `UTXO_SPENT (70): ${id}:0 utxo already spent by tx ${OTHER}[0]`,
    });
    const heal = await w.refuse();
    expect(heal?.released).toBe(1);
    expect(heal?.cleared).toEqual([`${w.ids[0]}_0`]);
    expect(heal?.alreadyOff).toBeUndefined();
    expect(w.rows[0].spendable).toBe(false);
    expect(w.recorded()).toEqual({ [`${w.ids[0]}_0`]: OTHER });
  });
  test('no row for the coin: never counted', async () => {
    const w = world({
      parents: [parent(1_000)],
      reason: ([id]) => `UTXO_SPENT (70): ${id}:0 utxo already spent by tx ${OTHER}[0]`,
      rows: [{ txid: 'f'.repeat(64) }],
    });
    const heal = await w.refuse();
    expect(heal?.released).toBe(0);
    expect(heal?.alreadyOff).toBeUndefined();
  });
});
