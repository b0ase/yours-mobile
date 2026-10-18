import { describe, expect, it } from 'vitest';
import {
  BURN_ADDRESSES,
  HOLDERS_PAGE,
  allocateFixed,
  allocateProRata,
  fetchHolders,
  filterHolders,
  formatUnits,
  interruptedBatch,
  isDone,
  makePlan,
  nextBatch,
  normTokenId,
  parseAddressList,
  parseHolders,
  dropId,
  mergeLedger,
  paidAddresses,
  pendingBatches,
  planSummary,
  parsePlan,
  previewDrop,
  receiptCsv,
  recordBatch,
  sentCount,
  serializePlan,
  startBatch,
  sumAmounts,
  toBatches,
  type Holder,
} from './holderDrop';

// Real mainnet addresses (from a live holders response).
const A = '1J4TnSj94pNUNc2qCvjRLcb8xTcz6fit43';
const B = '1LRSaaEYTqK5RNCMD3LCEeVnBW2NWa9vie';
const C = '1KgPN7U5LbaigFUZbYm3AxQYavRBq4MY67';
const TOKEN = '429bf19906897c0444a53bdf236473b1b3965a95a03f20863de640f49241d929_0';
const asset = { kind: 'token' as const, tokenId: TOKEN, dec: 8, symbol: 'BLASTER' };

describe('token id', () => {
  it('keys on the ID, never a ticker', () => {
    expect(normTokenId(TOKEN)).toBe(TOKEN);
    expect(normTokenId(TOKEN.replace('_', '.').toUpperCase())).toBe(TOKEN);
    expect(normTokenId('BLASTER')).toBeNull();
  });
});

describe('snapshot', () => {
  it('parses rows and fails closed on any row it cannot read', () => {
    expect(
      parseHolders([
        { address: A, amt: '5' },
        { address: B, amt: 7 },
      ]),
    ).toEqual([
      { address: A, amt: 5n },
      { address: B, amt: 7n },
    ]);
    expect(() =>
      parseHolders([
        { address: A, amt: '5' },
        { address: B, amt: '1.5' },
      ]),
    ).toThrow(/cannot read/);
    expect(() => parseHolders([{ amt: '3' }])).toThrow(/cannot read/);
    expect(() => parseHolders([null])).toThrow(/cannot read/);
    expect(() => parseHolders({ message: 'x' })).toThrow();
  });

  it('pages until a short page', async () => {
    const urls: string[] = [];
    const full = Array.from({ length: HOLDERS_PAGE }, () => ({ address: A, amt: '1' }));
    const f = async (u: string) => {
      urls.push(u);
      return { ok: true, status: 200, json: async () => (urls.length === 1 ? full : [{ address: B, amt: '2' }]) };
    };
    const hs = await fetchHolders(f, TOKEN);
    expect(hs).toHaveLength(HOLDERS_PAGE + 1);
    expect(urls[1]).toContain(`/${TOKEN}/holders?limit=${HOLDERS_PAGE}&offset=${HOLDERS_PAGE}`);
    await expect(fetchHolders(f, 'BLASTER')).rejects.toThrow(/token ID/);
  });

  it('fails on HTTP errors and on more than the cap', async () => {
    await expect(fetchHolders(async () => ({ ok: false, status: 503, json: async () => [] }), TOKEN)).rejects.toThrow(
      /503/,
    );
    const full = Array.from({ length: HOLDERS_PAGE }, () => ({ address: A, amt: '1' }));
    await expect(
      fetchHolders(async () => ({ ok: true, status: 200, json: async () => full }), TOKEN, HOLDERS_PAGE * 2),
    ).rejects.toThrow(/more than/);
  });

  it('excludes burn addresses, the sender, invalid, empty and below-minimum holders', () => {
    const raw: Holder[] = [
      { address: A, amt: 100n },
      { address: A, amt: 50n }, // duplicate row merges
      { address: B, amt: 10n },
      { address: C, amt: 3n },
      { address: BURN_ADDRESSES[0], amt: 1000n },
      { address: 'not-an-address', amt: 5n },
      { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', amt: 0n },
    ];
    const r = filterHolders(raw, { exclude: [B], minHolding: 5n });
    expect(r.holders).toEqual([{ address: A, amt: 150n }]);
    expect(r.skipped).toEqual({ burn: 1, sender: 1, blocked: 0, invalid: 1, belowMin: 1, empty: 1 });
    // No minimum: C stays; sorted largest first.
    expect(filterHolders(raw, { exclude: [B] }).holders.map((h) => h.address)).toEqual([A, C]);
    // Blocked (indexer fee address, pasted exchange/market addresses) are left out and counted.
    const blocked = filterHolders(raw, { exclude: [], block: [C] });
    expect(blocked.holders.map((h) => h.address)).toEqual([A, B]);
    expect(blocked.skipped.blocked).toBe(1);
  });

  it('reads a pasted address list and reports what is not an address', () => {
    expect(parseAddressList(`${A}, ${B}\n${A} nope`)).toEqual({ addresses: [A, B], bad: ['nope'] });
  });
});

describe('amounts', () => {
  const hs: Holder[] = [
    { address: A, amt: 1n },
    { address: B, amt: 1n },
    { address: C, amt: 1n },
  ];

  it('fixed: the same amount each', () => {
    expect(sumAmounts(allocateFixed(hs, 7n))).toBe(21n);
    expect(() => allocateFixed(hs, 0n)).toThrow();
  });

  it('pro-rata: sum is exactly the budget, never more', () => {
    const r = allocateProRata(hs, 100n);
    expect(sumAmounts(r)).toBe(100n);
    expect(r.map((x) => x.amount).sort()).toEqual([33n, 33n, 34n]);
    const big: Holder[] = [
      { address: A, amt: 149650000000000n },
      { address: B, amt: 144850000000000n },
      { address: C, amt: 70200000000000n },
    ];
    for (const budget of [1n, 2n, 3n, 999n, 10n ** 18n + 7n]) {
      const rr = allocateProRata(big, budget);
      expect(sumAmounts(rr)).toBe(budget);
      expect(rr.every((x) => x.amount >= 1n)).toBe(true);
    }
  });

  it('pro-rata: no dust, small holders drop out and the budget is re-split', () => {
    const skew: Holder[] = [
      { address: A, amt: 1000n },
      { address: B, amt: 1000n },
      { address: C, amt: 1n },
    ];
    const r = allocateProRata(skew, 100n, 10n);
    expect(r.map((x) => x.address)).toEqual([A, B]);
    expect(r.map((x) => x.amount)).toEqual([50n, 50n]);
    expect(sumAmounts(r)).toBe(100n);
    // Budget too small for anyone to reach the minimum: nobody.
    expect(allocateProRata(skew, 5n, 10n)).toEqual([]);
  });
});

describe('batches and preview', () => {
  it('splits into batches of N, capped', () => {
    expect(toBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(toBatches(Array.from({ length: 250 }), 1000)).toHaveLength(3);
    expect(toBatches([1], 0)).toEqual([[1]]);
  });

  it('previews total, holders, batches and fees', () => {
    const rs = allocateFixed(
      [
        { address: A, amt: 1n },
        { address: B, amt: 1n },
        { address: C, amt: 1n },
      ],
      5n,
    );
    const p = previewDrop(rs, asset, { batchSize: 2, satsPerKb: 100, feePerOutput: 10 });
    expect(p.holders).toBe(3);
    expect(p.batches).toBe(2);
    expect(p.total).toBe(15n);
    expect(p.indexerFee).toBe(10 * 3 + 10 * 2);
    expect(p.satsOut).toBe(BigInt(p.minerFee + p.indexerFee + 3));
    const bsv = previewDrop(rs, { kind: 'bsv' }, { batchSize: 50, satsPerKb: 100 });
    expect(bsv.indexerFee).toBe(0);
    expect(bsv.satsOut).toBe(15n + BigInt(bsv.minerFee));
  });
});

describe('resume and receipt', () => {
  const rs = allocateFixed(
    [
      { address: A, amt: 300n },
      { address: B, amt: 200n },
      { address: C, amt: 100n },
    ],
    1_00000000n,
  );
  const base = makePlan({
    id: 'p1',
    createdAt: 1,
    snapshotTokenId: TOKEN,
    asset,
    mode: 'fixed',
    recipients: rs,
    batchSize: 2,
  });

  it('records progress and resumes at the first unsent batch', () => {
    expect(nextBatch(base)).toBe(0);
    let p = recordBatch(base, 0, { txid: 't0' });
    p = recordBatch(p, 1, { error: 'offline' });
    expect(nextBatch(p)).toBe(1);
    expect(sentCount(p)).toBe(2);
    // Survives a restart (JSON round trip with bigints).
    const back = parsePlan(serializePlan(p))!;
    expect(back.batches[0].recipients[0].amount).toBe(1_00000000n);
    expect(nextBatch(back)).toBe(1);
    // A sent batch is never overwritten.
    expect(recordBatch(back, 0, { txid: 'other' }).batches[0].txid).toBe('t0');
    const done = recordBatch(back, 1, { txid: 't1' });
    expect(isDone(done)).toBe(true);
    expect(done.batches[1].error).toBeUndefined();
    expect(parsePlan('{bad')).toBeNull();
  });

  it('flags a batch interrupted mid-send so it is not blindly re-sent', () => {
    const p = startBatch(base, 0, 42);
    expect(interruptedBatch(p)).toBe(0);
    expect(interruptedBatch(parsePlan(serializePlan(p))!)).toBe(0);
    expect(interruptedBatch(recordBatch(p, 0, { txid: 'x' }))).toBe(-1);
    expect(interruptedBatch(recordBatch(p, 0, { error: 'refused' }))).toBe(-1);
  });

  it('exports a CSV receipt with txids', () => {
    const p = recordBatch(base, 0, { txid: 'abc' });
    const csv = receiptCsv(p, 2).trim().split('\n');
    expect(csv[0]).toBe('batch,address,amount (BLASTER),holding,txid,status');
    expect(csv[1]).toBe(`1,${A},1,3,abc,sent`);
    expect(csv[3]).toBe(`2,${C},1,1,,pending`);
    expect(formatUnits(1234n, 2)).toBe('12.34');
    expect(formatUnits(5n, 3)).toBe('0.005');
  });
});

describe('one approval, idempotent per holder per drop', () => {
  const hs: Holder[] = [
    { address: A, amt: 300n },
    { address: B, amt: 200n },
    { address: C, amt: 100n },
  ];
  const key = { snapshotTokenId: TOKEN, asset, mode: 'fixed' as const, amount: 5n };

  it('gives the same drop the same ID, and a different drop a different one', () => {
    expect(dropId(key)).toBe(dropId({ ...key }));
    expect(dropId(key)).toMatch(/^[0-9a-f]{24}$/);
    expect(dropId({ ...key, amount: 6n })).not.toBe(dropId(key));
    expect(dropId({ ...key, minHolding: 10n })).not.toBe(dropId(key));
    expect(dropId({ ...key, asset: { kind: 'bsv' } })).not.toBe(dropId(key));
  });

  it('summarises everything still to send for the one approval sheet', () => {
    const plan = makePlan({
      id: 'd',
      createdAt: 1,
      snapshotTokenId: TOKEN,
      asset,
      mode: 'prorata',
      recipients: allocateProRata(hs, 600n),
      batchSize: 2,
    });
    const s = planSummary(plan);
    expect(s).toMatchObject({ batches: 2, holders: 3, total: 600n, min: 100n, max: 300n });
    const after = recordBatch(plan, 0, { txid: 't0' });
    expect(pendingBatches(after)).toEqual([1]);
    expect(planSummary(after)).toMatchObject({ batches: 1, holders: 1, total: 100n });
    // An interrupted batch is never part of an approval until the issuer has checked it.
    expect(pendingBatches(startBatch(plan, 1, 9))).toEqual([0]);
  });

  it('never pays a holder twice under the same drop, even if the plan is rebuilt', () => {
    const id = dropId(key);
    const first = makePlan({
      id,
      createdAt: 1,
      snapshotTokenId: TOKEN,
      asset,
      mode: 'fixed',
      recipients: allocateFixed(hs, 5n),
      batchSize: 2,
    });
    const half = recordBatch(first, 0, { txid: 't0' });
    expect(paidAddresses(half)).toEqual([A, B]);
    let ledger = mergeLedger({}, half);
    ledger = mergeLedger(ledger, half); // merging twice changes nothing
    expect(ledger).toEqual({ [id]: [A, B] });
    // Discarded and built again from a fresh snapshot: only C is left to pay.
    const again = makePlan({
      id,
      createdAt: 2,
      snapshotTokenId: TOKEN,
      asset,
      mode: 'fixed',
      recipients: allocateFixed(hs, 5n),
      batchSize: 2,
      alreadyPaid: ledger[id],
    });
    expect(again.batches.flatMap((b) => b.recipients.map((r) => r.address))).toEqual([C]);
    // A different drop ID has its own ledger.
    expect(mergeLedger(ledger, { ...half, id: 'other' })).toEqual({ [id]: [A, B], other: [A, B] });
  });

  it('refuses a plan that names the same address twice', () => {
    const rs = allocateFixed(hs, 5n);
    expect(() =>
      makePlan({
        id: 'x',
        createdAt: 1,
        snapshotTokenId: TOKEN,
        asset,
        mode: 'fixed',
        recipients: [...rs, rs[0]],
        batchSize: 2,
      }),
    ).toThrow(/twice/);
  });

  it('batches stay under the cap and cover every holder exactly once', () => {
    const many: Holder[] = Array.from({ length: 250 }, (_, i) => ({ address: `addr${i}`, amt: BigInt(i + 1) }));
    const plan = makePlan({
      id: 'm',
      createdAt: 1,
      snapshotTokenId: TOKEN,
      asset,
      mode: 'prorata',
      recipients: allocateProRata(many, 1_000_000n),
      batchSize: 500,
    });
    expect(plan.batches.every((b) => b.recipients.length <= 100)).toBe(true);
    const all = plan.batches.flatMap((b) => b.recipients);
    expect(new Set(all.map((r) => r.address)).size).toBe(all.length);
    expect(sumAmounts(all)).toBe(1_000_000n);
  });
});

describe('BSV holder drops', () => {
  const bsv = { kind: 'bsv' as const };
  const hs: Holder[] = [
    { address: A, amt: 300n },
    { address: B, amt: 100n },
  ];

  it('plans pro-rata sats, batches them and keeps its own drop ID and ledger', () => {
    const id = dropId({ snapshotTokenId: TOKEN, asset: bsv, mode: 'prorata', amount: 10_000n });
    expect(id).not.toBe(dropId({ snapshotTokenId: TOKEN, asset, mode: 'prorata', amount: 10_000n }));
    const plan = makePlan({
      id,
      createdAt: 1,
      snapshotTokenId: TOKEN,
      asset: bsv,
      mode: 'prorata',
      recipients: allocateProRata(hs, 10_000n),
      batchSize: 1,
    });
    expect(plan.batches.map((b) => b.recipients[0].amount)).toEqual([7500n, 2500n]);
    const pv = previewDrop(
      plan.batches.flatMap((b) => b.recipients),
      bsv,
      { batchSize: 1, satsPerKb: 100 },
    );
    expect(pv.indexerFee).toBe(0);
    expect(pv.satsOut).toBe(10_000n + BigInt(pv.minerFee));
    const half = recordBatch(plan, 0, { txid: 't' });
    const again = makePlan({
      id,
      createdAt: 2,
      snapshotTokenId: TOKEN,
      asset: bsv,
      mode: 'prorata',
      recipients: allocateProRata(hs, 10_000n),
      batchSize: 1,
      alreadyPaid: mergeLedger({}, half)[id],
    });
    expect(again.batches.flatMap((b) => b.recipients.map((r) => r.address))).toEqual([B]);
  });
});
