/**
 * Find my locks, unit level (review 21): a mocked wallet and a mocked 1Sat indexer, so each failure mode can be set up
 * exactly. The real-toolbox round trip is lockFinder.roundtrip.test.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Beef, MerklePath, PrivateKey, Transaction, UnlockingScript, type WalletProtocol } from '@bsv/sdk';
import { Lock } from '@1sat/templates';
import type { OneSatContext } from '@1sat/actions';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage');
const kv = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => kv.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.set(k, String(v)),
  removeItem: (k: string) => void kv.delete(k),
  clear: () => kv.clear(),
};

const {
  MIN_FOUND_LOCK_SATS,
  bsvLockRepairs,
  bsvLocksScanDue,
  bsvLockScanKeys,
  bsvScanLine,
  findBsvLocks,
  scanBsvLocks,
} = await import('./lockFinder');
const { CLAIM_MAX_INPUTS, claimFeePerInput, claimableLocks, foundLockIdTag, syncClaimed, unclaimedOutpoints } =
  await import('./lockApi');
const { planPayouts } = await import('./claimPayouts');
const { localKeysFor } = await import('../account/deleteAccount');
type Plan = import('./schedule').LockPlan;

const HEIGHT = 900_100;
const ACCOUNT = '1UnitAccount';
const lockKey = PrivateKey.fromRandom();
const ADDR = lockKey.toAddress();
let identity = PrivateKey.fromRandom().toPublicKey().toString();
const H = (n: number) => n.toString(16).padStart(64, '0');

type Row = { outpoint: string; satoshis: number; tags: string[]; customInstructions?: string; spendable: boolean };

/** A wallet that files rows like the toolbox: one row per outpoint, merges keep `spendable`. */
function mockWallet(
  o: { refuse?: Map<string, string>; heldNotSpendable?: Set<string>; onInternalize?: () => void } = {},
) {
  const rows = new Map<string, Row>();
  for (const op of o.heldNotSpendable ?? []) rows.set(op, { outpoint: op, satoshis: 0, tags: [], spendable: false });
  const internalized: string[] = [];
  const wallet = {
    getPublicKey: async (a: { identityKey?: boolean; protocolID?: WalletProtocol; keyID?: string }) =>
      a.identityKey ? { publicKey: identity } : { publicKey: lockKey.toPublicKey().toString() },
    listOutputs: async () => ({
      outputs: [...rows.values()].filter((r) => r.spendable),
      totalOutputs: rows.size,
    }),
    internalizeAction: async (a: {
      tx: number[];
      outputs: { outputIndex: number; insertionRemittance: { tags: string[]; customInstructions: string } }[];
    }) => {
      const beef = Beef.fromBinary(a.tx);
      const txid = beef.atomicTxid!;
      internalized.push(txid);
      o.onInternalize?.();
      const refusal = o.refuse?.get(txid);
      if (refusal) throw new Error(refusal);
      const tx = beef.findTxid(txid)!.tx!;
      for (const out of a.outputs) {
        const op = `${txid}.${out.outputIndex}`;
        const had = rows.get(op);
        rows.set(op, {
          outpoint: op,
          satoshis: tx.outputs[out.outputIndex].satoshis!,
          tags: had ? had.tags : out.insertionRemittance.tags,
          customInstructions: out.insertionRemittance.customInstructions,
          spendable: had ? had.spendable : true,
        });
      }
      return { accepted: true };
    },
  };
  return { rows, internalized, wallet };
}

let seq = 0;
function txWith(outs: { script: ReturnType<typeof Lock.lock>; sats: number }[], mined = true) {
  const t = new Transaction();
  t.addInput({ sourceTXID: H(++seq + 7000), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
  for (const o of outs) t.addOutput({ lockingScript: o.script, satoshis: o.sats });
  const txid = t.id('hex');
  if (mined) t.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: txid, txid: true }]]);
  return t;
}
const lock = (sats: number, until = HEIGHT + 100) => ({ script: Lock.lock(ADDR, until), sats });

type IndexerOpts = {
  /** The indexer's own view of spends (search and getSpends both read it, as in production). */
  spent?: Map<string, string>;
  /** Outpoints search still lists although the indexer knows they are spent (search lags its spend index). */
  staleSearch?: Set<string>;
  failBeef?: Set<string>;
  /** Report satoshis in search results (sats: true). */
  sats?: boolean;
  /** A hostile listing: extra outpoints returned for own:<address>. */
  extra?: string[];
  spendsAnswer?: (ops: string[]) => unknown;
  hangSync?: boolean;
  log?: string[];
};
function indexer(txs: Transaction[], o: IndexerOpts = {}) {
  const byId = new Map(txs.map((t) => [t.id('hex'), t]));
  const spent = o.spent ?? new Map<string, string>();
  let inFlight = 0;
  const stats = { maxInFlight: 0, beef: [] as string[], spendCalls: [] as number[], searchOpts: [] as unknown[] };
  const svc = {
    stats,
    owner: {
      async *getTxos() {
        if (o.hangSync) await new Promise(() => undefined);
        yield { type: 'done' as const };
      },
    },
    txo: {
      search: async (key: string, opts: unknown) => {
        stats.searchOpts.push(opts);
        const owner = key.replace(/^own:/, '');
        const hits: { outpoint: string; score: number; satoshis?: number }[] = [];
        for (const [txid, t] of byId)
          t.outputs.forEach((out, v) => {
            const op = `${txid}.${v}`;
            const owned = Lock.decode(out.lockingScript)?.address === owner;
            if (owned && (!spent.has(op) || o.staleSearch?.has(op)))
              hits.push({ outpoint: op, score: hits.length, ...(o.sats ? { satoshis: out.satoshis } : {}) });
          });
        for (const x of o.extra ?? []) {
          const [txid, v] = x.split('.');
          const sats = byId.get(txid)?.outputs[Number(v)]?.satoshis;
          hits.push({ outpoint: x, score: hits.length, ...(o.sats ? { satoshis: sats } : {}) });
        }
        return hits;
      },
      getSpends: async (ops: string[]) => {
        stats.spendCalls.push(ops.length);
        if (o.spendsAnswer) return o.spendsAnswer(ops);
        return ops.map((op) => spent.get(op) ?? null);
      },
    },
    getBeefForTxid: async (txid: string) => {
      stats.beef.push(txid);
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 2));
        if (o.failBeef?.has(txid)) throw new Error('504 gateway timeout');
        const b = new Beef();
        b.mergeTransaction(byId.get(txid)!);
        return Beef.fromBinary(b.toBinary());
      } finally {
        inFlight--;
      }
    },
    chaintracks: { currentHeight: async () => HEIGHT },
  };
  o.log?.push('indexer');
  return svc;
}
const ctxOf = (wallet: unknown, services: unknown) => ({ wallet, services, chain: 'main' }) as unknown as OneSatContext;

beforeEach(() => {
  kv.clear();
  identity = PrivateKey.fromRandom().toPublicKey().toString();
});

describe('M1: a lock transaction that cannot be read is reported and the device is not marked', () => {
  test('one BEEF download fails: the other lock is added, the failed one is named, the scan stays due', async () => {
    const t1 = txWith([lock(50_000)]);
    const t2 = txWith([lock(70_000)]);
    const w = mockWallet();
    const idx = indexer([t1, t2], { failBeef: new Set([t2.id('hex')]) });
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, { store: 'S1' });
    expect(r.added).toBe(1);
    expect(r.retry).toEqual([`${t2.id('hex')}: could not be read (504 gateway timeout)`]);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', Date.now() + 3_600_001)).toBe(true);
    expect(bsvScanLine({ kind: 'done', scan: r })).toMatch(/1 couldn't be checked yet; tried again later/);
  });
});

describe('M2: dust and 1-sat outputs are never downloaded or filed', () => {
  test('with satoshis from the indexer, outputs under the floor are dropped before any download', async () => {
    const dust = txWith([lock(1, HEIGHT - 50), lock(1, HEIGHT - 50), lock(MIN_FOUND_LOCK_SATS - 1, HEIGHT - 50)]);
    const real = txWith([lock(50_000)]);
    const w = mockWallet();
    const idx = indexer([dust, real], { sats: true });
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, {});
    expect(idx.stats.beef).toEqual([real.id('hex')]);
    expect(idx.stats.searchOpts[0]).toMatchObject({ unspent: true, sats: true });
    expect(r).toMatchObject({ found: 1, added: 1, addedSats: 50_000 });
    expect([...w.rows.keys()]).toEqual([`${real.id('hex')}.0`]);
  });

  test('without satoshis from the indexer, the floor still holds after reading the transaction', async () => {
    const dust = txWith([lock(1, HEIGHT - 50), lock(999, HEIGHT - 50), lock(1000, HEIGHT - 50)]);
    const w = mockWallet();
    const r = await findBsvLocks(ctxOf(w.wallet, indexer([dust])), ACCOUNT, {});
    expect(r).toMatchObject({ found: 1, added: 1, addedSats: 1000 });
    expect([...w.rows.keys()]).toEqual([`${dust.id('hex')}.2`]);
  });
});

describe('Claim rule (N3): own locks pay for themselves; locks the finder adds keep the 1,000-sat floor', () => {
  const own = (sats: number, until: number, n = sats + until) => ({
    outpoint: `${H(n)}.0`,
    satoshis: sats,
    tags: [`until:${until}`, `id:${H(n).slice(0, 16)}_0`], // a random action id, as the lock flow stamps
  });
  const found = (sats: number, until: number, n = sats + until) => ({
    outpoint: `${H(n)}.0`,
    satoshis: sats,
    tags: [`until:${until}`, foundLockIdTag(H(n), 0)],
  });
  test('matured + id-tagged; own locks claimable when worth more than their fee; found locks need 1,000 sats', () => {
    const rows = [
      own(1, HEIGHT - 1, 1),
      own(900, HEIGHT - 1, 2),
      own(50_000, HEIGHT - 1, 3),
      own(60_000, HEIGHT + 1, 4), // not matured
      { ...own(70_000, HEIGHT, 5), tags: [`until:${HEIGHT}`] }, // no id: unlockBsv can't sign it
      found(999, HEIGHT - 1, 6),
      found(1_000, HEIGHT - 1, 7),
    ];
    const c = claimableLocks(rows, HEIGHT);
    expect(c.picks.map((p) => p.outpoint).sort()).toEqual([`${H(2)}.0`, `${H(3)}.0`, `${H(7)}.0`].sort());
    expect(c.sats).toBe(900 + 50_000 + 1_000);
    expect(c.ids).toContain(`${H(2).slice(0, 16)}_0`);
    // At a high custom fee rate (1 sat/byte) a 900-sat lock costs more to claim than it holds: left alone.
    const dear = claimableLocks(rows, HEIGHT, { satsPerKb: 1_000 });
    expect(dear.picks.map((p) => p.outpoint)).not.toContain(`${H(2)}.0`);
    expect(dear.sats).toBeGreaterThan(dear.picks.length * claimFeePerInput(1_000));
  });

  test('no cap in the rule itself: claimLocks splits it into claims of at most 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => own(10_000 + i, HEIGHT - 1, 100 + i));
    expect(claimableLocks(many, HEIGHT).picks).toHaveLength(80);
    expect(CLAIM_MAX_INPUTS).toBe(50);
  });
});

describe('N1: plan payouts count only the locks a claim actually spent', () => {
  const txid = H(77);
  const plan = (): Plan => ({
    id: txid,
    label: 'Daily',
    mode: 'percent',
    txids: [txid],
    createdAt: '2026-11-01T00:00:00.000Z',
    frequency: 'daily',
    pendingAmounts: [5_000, 5_000, 5_000],
    pieces: Array.from({ length: 60 }, (_, i) => ({
      vout: i,
      height: HEIGHT - 100 + i,
      sats: i === 59 ? 15_000 : 2_000,
      txid,
      ...(i === 59 ? { tail: true } : {}),
    })),
  });
  const all = new Set(Array.from({ length: 60 }, (_, i) => `${txid}.${i}`));

  test('all 60 spent: 60 lines and the "Lock next payouts" batch for the tail', () => {
    const out = planPayouts([plan()], HEIGHT, all, 50);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toHaveLength(60);
    expect(out[0].batch).toBeDefined();
  });

  test('the tail not spent (left locked): no line for it and no re-lock offer', () => {
    const spent = new Set([...all].filter((o) => o !== `${txid}.59`));
    const out = planPayouts([plan()], HEIGHT, spent, 50);
    expect(out[0].lines).toHaveLength(59);
    expect(out[0].batch).toBeUndefined();
    expect(out[0].lines.join(' ')).not.toMatch(/remaining .* payouts/);
  });

  test('nothing spent: no payout card at all', () => {
    expect(planPayouts([plan()], HEIGHT, new Set(), 50)).toEqual([]);
  });
});

describe('M3: failures are sorted into retry-later and needs-repair', () => {
  test('a transaction this device holds as failed goes to the payment repair, then to needs-repair; the scan is done', async () => {
    const t = txWith([lock(50_000)]);
    const txid = t.id('hex');
    const w = mockWallet({
      refuse: new Map([
        [txid, 'The tx parameter must be target transaction of internalizeAction has invalid status failed.'],
      ]),
    });
    const repaired: string[] = [];
    const idx = indexer([t]);
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, {
      store: 'S1',
      repairTxid: async (x) => {
        repaired.push(x);
        return false;
      },
    });
    expect(repaired).toEqual([txid]);
    expect(r.added).toBe(0);
    expect(r.retry).toEqual([]);
    expect(r.repair).toHaveLength(1);
    expect(r.repair[0]).toMatch(new RegExp(`^${txid}\\.0: .*held as failed.*Recover a payment by transaction ID`));
    expect(bsvLocksScanDue(ACCOUNT, 'S1')).toBe(false);
    expect(bsvLockRepairs(ACCOUNT)).toEqual(r.repair);
  });

  test('when the payment repair fixes the transaction, the lock is filed in the same run', async () => {
    const t = txWith([lock(50_000)]);
    const txid = t.id('hex');
    const refuse = new Map([[txid, 'has invalid status failed']]);
    const w = mockWallet({ refuse });
    const r = await findBsvLocks(ctxOf(w.wallet, indexer([t])), ACCOUNT, {
      repairTxid: async () => {
        refuse.delete(txid);
        return true;
      },
    });
    expect(r).toMatchObject({ added: 1, retry: [], repair: [] });
  });

  test('a row the device holds as not spendable is needs-repair, not retried on every open', async () => {
    const t = txWith([lock(50_000)]);
    const op = `${t.id('hex')}.0`;
    const w = mockWallet({ heldNotSpendable: new Set([op]) });
    const idx = indexer([t]);
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, { store: 'S1' });
    expect(r.added).toBe(0);
    expect(r.repair).toEqual([`${op}: this device holds it as spent or not usable yet (an unlock in flight?)`]);
    expect(bsvLocksScanDue(ACCOUNT, 'S1')).toBe(false);
  });

  test('transient failures back off: 1 h, then 2 h, … capped at 24 h; a clean run clears it', async () => {
    const t = txWith([lock(50_000)]);
    const w = mockWallet();
    const bad = indexer([t], { failBeef: new Set([t.id('hex')]) });
    let now = 1_000_000_000_000;
    const run = (svc: unknown) => findBsvLocks(ctxOf(w.wallet, svc), ACCOUNT, { store: 'S1', now: () => now });
    await run(bad);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now)).toBe(false);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 3_600_000)).toBe(true);
    now += 3_600_000;
    await run(bad);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 3_600_000)).toBe(false);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 7_200_000)).toBe(true);
    for (let i = 0; i < 8; i++) {
      now += 86_400_000;
      await run(bad);
    }
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 86_400_000 - 1)).toBe(false);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 86_400_000)).toBe(true);
    now += 86_400_000;
    const ok = await run(indexer([t]));
    expect(ok.added).toBe(1);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', now + 10 * 86_400_000)).toBe(false);
  });
});

describe('L1: the spend check files only on a clear "unspent"', () => {
  test('null = unspent (filed); a txid = spent; anything else is unclear and retried later', async () => {
    const t = txWith([lock(10_000), lock(20_000), lock(30_000), lock(40_000)]);
    const w = mockWallet();
    const idx = indexer([t], { spendsAnswer: () => [null, 'ab'.repeat(32), '', undefined] });
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, { store: 'S1' });
    expect(r).toMatchObject({ added: 1, addedSats: 10_000, spent: 1 });
    expect(r.retry).toEqual([
      `${t.id('hex')}.2: the indexer gave no clear answer whether it is spent`,
      `${t.id('hex')}.3: the indexer gave no clear answer whether it is spent`,
    ]);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', Date.now() + 3_600_001)).toBe(true);
  });

  test('a short answer list (answers matched by position only) files nothing from that batch', async () => {
    const t = txWith([lock(10_000), lock(20_000)]);
    const w = mockWallet();
    const r = await findBsvLocks(ctxOf(w.wallet, indexer([t], { spendsAnswer: () => [null] })), ACCOUNT, {});
    expect(r.added).toBe(0);
    expect(r.retry).toHaveLength(2);
    expect(w.internalized).toEqual([]);
  });

  test('the spend check is down: nothing filed, retried later', async () => {
    const t = txWith([lock(10_000)]);
    const w = mockWallet();
    const idx = indexer([t], {
      spendsAnswer: () => {
        throw new Error('spends down');
      },
    });
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, {});
    expect(r.added).toBe(0);
    expect(r.retry).toEqual([`${t.id('hex')}.0: could not check it is unspent (spends down)`]);
    expect(w.internalized).toEqual([]);
  });
});

describe('L2: a lock that is not mined yet is not filed (nothing is broadcast)', () => {
  test('BEEF without a proof for the lock tx: pending, retried later, no internalize', async () => {
    const t = txWith([lock(50_000)], false);
    const w = mockWallet();
    const r = await findBsvLocks(ctxOf(w.wallet, indexer([t])), ACCOUNT, {});
    expect(w.internalized).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.retry).toEqual([`${t.id('hex')}.0: not mined yet`]);
  });
});

describe('L3: the scanned flag belongs to the device store it describes', () => {
  test('a new store (or no flag) is due; the same store is not; removing the account clears the flags', async () => {
    const t = txWith([lock(50_000)]);
    await findBsvLocks(ctxOf(mockWallet().wallet, indexer([t])), ACCOUNT, { store: 'store-A' });
    expect(bsvLocksScanDue(ACCOUNT, 'store-A')).toBe(false);
    expect(bsvLocksScanDue(ACCOUNT, 'store-B')).toBe(true);
    expect(bsvLocksScanDue('1Other', 'store-A')).toBe(true);
    const idKey = PrivateKey.fromRandom().toPublicKey();
    const keys = localKeysFor(idKey.toString());
    for (const k of bsvLockScanKeys(idKey.toAddress())) expect(keys).toContain(k);
    expect(keys).toContain(`bwx.tokenLocks.scanned.${idKey.toAddress()}`);
  });
});

describe('L5: a stalled sync cannot hang the scan or the button', () => {
  test('the sync phase times out', async () => {
    const w = mockWallet();
    await expect(
      findBsvLocks(ctxOf(w.wallet, indexer([], { hangSync: true })), ACCOUNT, { syncTimeoutMs: 30 }),
    ).rejects.toThrow(/timed out/);
  });

  test('a manual run replaces an in-flight run older than the stale limit; a fresh one is joined', async () => {
    const t = txWith([lock(50_000)]);
    let now = 5_000_000;
    const hung = scanBsvLocks(ctxOf(mockWallet().wallet, indexer([], { hangSync: true })), '1Hung', {
      now: () => now,
      syncTimeoutMs: 300,
    });
    void hung.catch(() => undefined);
    const joined = scanBsvLocks(ctxOf(mockWallet().wallet, indexer([t])), '1Hung', { now: () => now });
    expect(joined).toBe(hung);
    now += 4 * 60_000;
    const fresh = scanBsvLocks(ctxOf(mockWallet().wallet, indexer([t])), '1Hung', { now: () => now });
    expect(fresh).not.toBe(hung);
    expect((await fresh).added).toBe(1);
  });
});

describe('L6: downloads are bounded', () => {
  test('at most 4 downloads at once; a run stops at its cap and the next run carries on', async () => {
    const txs = Array.from({ length: 9 }, (_, i) => txWith([lock(10_000 + i)]));
    const w = mockWallet();
    const idx = indexer(txs);
    const r1 = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, { store: 'S1', maxTxs: 5 });
    expect(idx.stats.maxInFlight).toBeLessThanOrEqual(4);
    expect(idx.stats.beef).toHaveLength(5);
    expect(r1.added).toBe(5);
    expect(r1.retry).toEqual(['4 more transactions: next run']);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', Date.now() + 3_600_001)).toBe(true);
    const idx2 = indexer(txs);
    const r2 = await findBsvLocks(ctxOf(w.wallet, idx2), ACCOUNT, { store: 'S1', maxTxs: 5 });
    expect(idx2.stats.beef).toHaveLength(4); // the 5 already filed are not downloaded again
    expect(r2).toMatchObject({ added: 4, already: 5, retry: [] });
  });

  test('the spend check is batched (100 a call)', async () => {
    const outs = Array.from({ length: 150 }, (_, i) => lock(1_000 + i));
    const t = txWith(outs);
    const idx = indexer([t]);
    const r = await findBsvLocks(ctxOf(mockWallet().wallet, idx), ACCOUNT, {});
    expect(idx.stats.spendCalls).toEqual([100, 50]);
    expect(r.added).toBe(150);
  });
});

describe('L8: an account switch during a scan files nothing into the other account', () => {
  test('the identity key changes before filing: nothing more is filed, the scan stays due', async () => {
    const t1 = txWith([lock(50_000)]);
    const w = mockWallet();
    const idx = indexer([t1]);
    const real = idx.txo.getSpends;
    idx.txo.getSpends = async (ops: string[]) => {
      identity = PrivateKey.fromRandom().toPublicKey().toString(); // the switch lands here
      return real(ops);
    };
    const r = await findBsvLocks(ctxOf(w.wallet, idx), ACCOUNT, { store: 'S1' });
    expect(w.internalized).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.retry).toEqual([`${t1.id('hex')}.0: the account changed during the search`]);
    expect(bsvLocksScanDue(ACCOUNT, 'S1', Date.now() + 3_600_001)).toBe(true);
  });
});

describe('L4: a plan never hides a lock that is back in the wallet', () => {
  const plan = (txid: string): Plan => ({
    id: txid,
    label: 'Savings',
    mode: 'date',
    txids: [txid],
    createdAt: '2026-11-01T00:00:00.000Z',
    pieces: [
      { vout: 0, height: HEIGHT - 5, sats: 50_000, txid },
      { vout: 1, height: HEIGHT + 5, sats: 50_000, txid },
    ],
  });
  test('syncClaimed un-claims a piece whose output is in the lock basket; planned outpoints skip claimed pieces', () => {
    const txid = H(42);
    // Restored plans, before the finder ran: the matured piece looks claimed.
    const [early] = syncClaimed([plan(txid)], new Set(), HEIGHT);
    expect(early.pieces[0].claimed).toBe(true);
    expect(unclaimedOutpoints([early])).toEqual(new Set([`${txid}.1`]));
    // The finder filed both: the piece is unclaimed again.
    const [later] = syncClaimed([early], new Set([`${txid}.0`, `${txid}.1`]), HEIGHT);
    expect(later.pieces[0].claimed).toBeFalsy();
    expect(unclaimedOutpoints([later])).toEqual(new Set([`${txid}.0`, `${txid}.1`]));
  });
});
