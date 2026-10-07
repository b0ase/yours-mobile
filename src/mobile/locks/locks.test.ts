import { describe, expect, test } from 'bun:test';
import { Lock, buildInscriptionScript } from '@1sat/templates';
import { P2PKH, PrivateKey, Spend, Transaction } from '@bsv/sdk';
import {
  MAX_PIECES,
  MIN_PIECE_SATS,
  aggregate,
  batches,
  buildGradual,
  buildOnce,
  buildPercent,
  dateForHeight,
  heightForDate,
  matured,
  payoutFor,
  percentAmounts,
  planStatus,
  stepDate,
  usdToSats,
  type LockPlan,
} from './schedule';
import { buildReceipt, parseReceipt, receiptMap, receiptSvg } from './receipt';
import { checkLockTx } from './verify';

const NOW = new Date('2026-10-07T12:00:00Z');
const H = 970_000;
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('date ↔ height', () => {
  test('144 blocks a day from the current height', () => {
    expect(heightForDate(day(1), NOW, H)).toBe(H + 144);
    expect(heightForDate(day(7), NOW, H)).toBe(H + 1008);
  });
  test('never earlier than the next block', () => {
    expect(heightForDate(NOW, NOW, H)).toBe(H + 1);
    expect(heightForDate(day(-3), NOW, H)).toBe(H + 1);
  });
  test('round trip is approximate but exact at 10-minute blocks', () => {
    expect(dateForHeight(H + 144, NOW, H).getTime()).toBe(day(1).getTime());
  });
  test('monthly steps are calendar months, clamped to month end', () => {
    const jan31 = new Date(2027, 0, 31);
    expect(stepDate(jan31, 'monthly', 1).getDate()).toBe(28);
    expect(stepDate(jan31, 'monthly', 2).getMonth()).toBe(2);
  });
});

describe('schedules', () => {
  test('one date', () => {
    const r = buildOnce(10_000_000, day(30), NOW, H);
    expect(r.pieces).toHaveLength(1);
    expect(r.pieces[0].height).toBe(H + 30 * 144);
    expect(buildOnce(10_000_000, day(-1), NOW, H).error).toBeTruthy();
    expect(buildOnce(10, day(5), NOW, H).error).toBeTruthy();
  });
  test('0.1 BSV a week for 10 weeks', () => {
    const r = buildGradual({ start: day(7), frequency: 'weekly', count: 10, perPayoutSats: 10_000_000 }, NOW, H);
    expect(r.pieces).toHaveLength(10);
    expect(r.totalSats).toBe(100_000_000);
    expect(r.pieces[1].height - r.pieces[0].height).toBe(1008);
  });
  test('total split evenly; remainder on the last piece; nothing lost', () => {
    const r = buildGradual({ start: day(1), frequency: 'daily', count: 3, totalSats: 100_000 }, NOW, H);
    expect(r.pieces.map((p) => p.sats)).toEqual([33_333, 33_333, 33_334]);
  });
  test('total at a fixed rate: a dust tail folds into the previous piece', () => {
    const r = buildGradual({ start: day(1), frequency: 'daily', totalSats: 30_500, perPayoutSats: 10_000 }, NOW, H);
    expect(r.pieces.map((p) => p.sats)).toEqual([10_000, 10_000, 10_500]);
  });
  test('end date decides the count', () => {
    const r = buildGradual({ start: day(1), frequency: 'daily', end: day(5), perPayoutSats: 5000 }, NOW, H);
    expect(r.pieces).toHaveLength(5);
  });
  test('pieces under the minimum are refused', () => {
    expect(buildGradual({ start: day(1), frequency: 'daily', count: 5, perPayoutSats: 500 }, NOW, H).error).toContain('1,000');
  });
  test(`more than ${MAX_PIECES} payouts is refused with a batching hint`, () => {
    const r = buildGradual({ start: day(1), frequency: 'daily', count: MAX_PIECES + 1, perPayoutSats: 5000 }, NOW, H);
    expect(r.error).toContain('batches');
    expect(batches(Array.from({ length: 1100 }, (_, i) => i)).map((b) => b.length)).toEqual([520, 520, 60]);
  });
  test('heights strictly increase even when dates share a block', () => {
    const r = buildGradual({ start: NOW, frequency: 'custom', customDays: 1, count: 3, perPayoutSats: 5000 }, NOW, H);
    const hs = r.pieces.map((p) => p.height);
    expect(new Set(hs).size).toBe(3);
  });
  test('$10 a day with a 20% buffer at $50/BSV', () => {
    const r = buildGradual({ start: day(1), frequency: 'daily', count: 3, usdPerPayout: 10, rate: 50, bufferPct: 20 }, NOW, H);
    expect(r.pieces[0].sats).toBe(usdToSats(12, 50));
    expect(r.pieces[0].sats).toBe(24_000_000);
    expect(r.pieces[0].usdTarget).toBe(10);
  });
  test('dollar mode without a price is refused, not guessed', () => {
    expect(buildGradual({ start: day(1), frequency: 'daily', count: 3, usdPerPayout: 10, rate: 0 }, NOW, H).error).toContain('unavailable');
  });
});

describe('dollar-target payouts', () => {
  const piece = 24_000_000; // $12 at $50
  test('price up: pay the target, re-lock the surplus', () => {
    const p = payoutFor(piece, 10, 60, true);
    expect(p.kind).toBe('paid');
    if (p.kind !== 'paid') return;
    expect(p.paySats).toBe(usdToSats(10, 60));
    expect(p.surplusSats).toBe(piece - usdToSats(10, 60));
    expect(p.relock).toBe(true);
    expect(p.paidUsd).toBe(10);
  });
  test('last piece: surplus stays in the wallet', () => {
    const p = payoutFor(piece, 10, 60, false);
    expect(p.kind === 'paid' && p.relock).toBe(false);
    expect(p.kind === 'paid' && p.paySats).toBe(piece);
  });
  test('price down past the buffer: shortfall pays the whole piece', () => {
    const p = payoutFor(piece, 10, 35, true);
    expect(p).toEqual({ kind: 'short', paySats: piece, paidUsd: 8.4, targetUsd: 10 });
  });
  test('no price: wait', () => {
    expect(payoutFor(piece, 10, 0, true).kind).toBe('wait');
    expect(payoutFor(piece, 10, null, true).kind).toBe('wait');
    expect(payoutFor(piece, 10, Number.NaN, true).kind).toBe('wait');
  });
  test('surplus under the minimum is not worth a lock', () => {
    const p = payoutFor(usdToSats(10, 50) + 500, 10, 50, true);
    expect(p.kind === 'paid' && p.relock).toBe(false);
  });
});

describe('percentage payouts', () => {
  test('% of original: linear, ends after 100/X periods', () => {
    const a = percentAmounts(1_000_000, 10, 'original') as number[];
    expect(a).toHaveLength(10);
    expect(a.every((x) => x === 100_000)).toBe(true);
    const b = percentAmounts(100_000_000, 0.01, 'original') as number[];
    expect(b).toHaveLength(10_000);
    expect(b.reduce((s, x) => s + x, 0)).toBe(100_000_000);
  });
  test('% of original with a non-dividing percentage keeps every sat', () => {
    const a = percentAmounts(1_000_003, 30, 'original') as number[];
    expect(a.reduce((s, x) => s + x, 0)).toBe(1_000_003);
    expect(a).toHaveLength(4);
  });
  test('% of remaining: declining, final piece takes the rest', () => {
    const a = percentAmounts(1_000_000, 10, 'remaining') as number[];
    expect(a[0]).toBe(100_000);
    expect(a[1]).toBe(90_000);
    expect(a.reduce((s, x) => s + x, 0)).toBe(1_000_000);
    expect(a.slice(0, -1).every((x) => x >= MIN_PIECE_SATS)).toBe(true);
  });
  test('dust: tiny daily pieces are refused with a merge suggestion', () => {
    const e = percentAmounts(1_000_000, 0.01, 'original');
    expect(typeof e).toBe('string');
    expect(e as string).toContain('weekly');
  });
  test('long schedules fold into a tail lock and report the end date', () => {
    const r = buildPercent({ totalSats: 100_000_000, pct: 0.01, base: 'original', start: day(1), frequency: 'daily' }, NOW, H);
    expect(r.periods).toBe(10_000);
    expect(r.pieces).toHaveLength(MAX_PIECES);
    expect(r.tail).toBe(true);
    expect(r.totalSats).toBe(100_000_000);
    expect(r.pieces[MAX_PIECES - 1].sats).toBe(100_000_000 - 10_000 * (MAX_PIECES - 1));
    expect(r.end!.getTime()).toBe(stepDate(day(1), 'daily', 9_999).getTime());
  });
});

describe('many locks', () => {
  const plan = (id: string, pieces: [number, number, boolean?][]): LockPlan => ({
    id,
    label: id,
    mode: 'bsv',
    txids: ['t'],
    createdAt: '',
    pieces: pieces.map(([height, sats, claimed], vout) => ({ txid: 't', vout, height, sats, claimed })),
  });
  test('status and totals across locks', () => {
    const a = plan('a', [[H - 1, 1000, true], [H, 2000], [H + 10, 3000]]);
    const b = plan('b', [[H + 5, 7000]]);
    expect(planStatus(a, H)).toEqual({ status: 'Ready to claim', locked: 5000, ready: 2000, next: H + 10 });
    expect(planStatus(b, H).status).toBe('Locked');
    expect(aggregate([a, b], H)).toEqual({ locked: 12_000, ready: 2000, next: H + 5, count: 2 });
    expect(planStatus(plan('c', [[1, 1, true]]), H).status).toBe('Finished');
  });
  test('claim only selects matured outputs', () => {
    const locks = [
      { outpoint: 'a.0', satoshis: 1, until: H - 5 },
      { outpoint: 'a.1', satoshis: 1, until: H },
      { outpoint: 'a.2', satoshis: 1, until: H + 1 },
    ];
    expect(matured(locks, H).map((l) => l.outpoint)).toEqual(['a.0', 'a.1']);
  });
});

// ── the script itself, run through the @bsv/sdk interpreter ─────────────────

const key = PrivateKey.fromRandom();
const address = key.toAddress();
const UNTIL = 970_500;

function fundedLockTx(outputs: { height: number; sats: number }[], extra: { lockingScript: ReturnType<typeof Lock.lock>; satoshis: number }[] = []) {
  const src = new Transaction();
  src.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(address), sequence: 0xffffffff });
  for (const o of outputs) src.addOutput({ lockingScript: Lock.lock(address, o.height), satoshis: o.sats });
  for (const e of extra) src.addOutput(e);
  return src;
}

async function trySpend(lockTime: number, sequence = 0, signer = key) {
  const src = fundedLockTx([{ height: UNTIL, sats: 50_000 }]);
  const tx = new Transaction();
  tx.lockTime = lockTime;
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence, unlockingScriptTemplate: Lock.unlock(signer) });
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 49_000 });
  await tx.sign();
  const input = tx.inputs[0];
  const spend = new Spend({
    sourceTXID: src.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 50_000,
    lockingScript: src.outputs[0].lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    inputIndex: 0,
    unlockingScript: input.unlockingScript!,
    inputSequence: sequence,
    lockTime,
  });
  try {
    return spend.validate();
  } catch {
    return false;
  }
}

describe('lock script (interpreter)', () => {
  test('the template encodes the height and the owner key hash', () => {
    const d = Lock.decode(Lock.lock(address, UNTIL));
    expect(d).toEqual({ address, until: UNTIL });
  });
  test('cannot be spent with nLockTime below the height', async () => {
    expect(await trySpend(UNTIL - 1)).toBe(false);
    expect(await trySpend(0)).toBe(false);
  });
  test('cannot dodge nLockTime with a final sequence number', async () => {
    expect(await trySpend(UNTIL, 0xffffffff)).toBe(false);
  });
  test('cannot be spent by another key, even after the height', async () => {
    expect(await trySpend(UNTIL + 10, 0, PrivateKey.fromRandom())).toBe(false);
  });
  test('spendable by the owner at and after the height', async () => {
    expect(await trySpend(UNTIL)).toBe(true);
    expect(await trySpend(UNTIL + 1000)).toBe(true);
  });
  test('size: one lock output for fee planning', () => {
    const bytes = Lock.lock(address, UNTIL).toBinary().length;
    expect(bytes).toBeGreaterThan(900);
    expect(bytes).toBeLessThan(1100);
  });
});

describe('receipt + verifier', () => {
  const pieces = [
    { height: UNTIL, sats: 10_000 },
    { height: UNTIL + 144, sats: 10_000 },
  ];
  const receipt = buildReceipt({ mode: 'usd-target', pieces, lockAddress: address, identity: { handle: '$b0asex', address }, rate: 50, usdPerPayout: 0.004, bufferPct: 20, now: NOW });
  const inscription = (r: typeof receipt) => buildInscriptionScript(new P2PKH().lock(address), new TextEncoder().encode(receiptSvg(r)), 'image/svg+xml', receiptMap(r));

  test('receipt JSON from the schedule', () => {
    expect(receipt).toMatchObject({ app: 'bwalletx', type: 'lock-receipt', v: 1, mode: 'usd-target', amountSats: 20_000, usdPerPayout: 0.004, bufferPct: 20, lockAddress: address });
    expect(receipt.schedule).toEqual([
      { vout: 0, height: UNTIL, sats: 10_000 },
      { vout: 1, height: UNTIL + 144, sats: 10_000 },
    ]);
    expect(receiptSvg(receipt)).toContain('Verify at bwalletx.com/lock/verify');
    expect(parseReceipt(inscription(receipt))).toEqual(receipt);
  });
  test('a genuine receipt verifies; status follows spends', () => {
    const tx = fundedLockTx(pieces, [{ lockingScript: inscription(receipt), satoshis: 1 }]);
    const v = checkLockTx(tx.toHex(), new Set(), UNTIL - 1);
    expect(v.receiptValid).toBe(true);
    expect(v.status).toBe('Locked');
    expect(checkLockTx(tx.toHex(), new Set([0]), UNTIL).status).toBe('Partly claimed');
    expect(checkLockTx(tx.toHex(), new Set([0, 1]), UNTIL + 200).status).toBe('Fully claimed');
  });
  test('a receipt claiming more than is locked is rejected', () => {
    const fake = { ...receipt, amountSats: 2_000_000, schedule: receipt.schedule.map((s) => ({ ...s, sats: 1_000_000 })) };
    const tx = fundedLockTx(pieces, [{ lockingScript: inscription(fake), satoshis: 1 }]);
    const v = checkLockTx(tx.toHex(), new Set(), 0);
    expect(v.receiptValid).toBe(false);
    expect(v.problems.join(' ')).toContain('holds 10000 sats');
  });
  test('a receipt with a later height than the chain enforces is rejected', () => {
    const fake = { ...receipt, schedule: receipt.schedule.map((s) => ({ ...s, height: s.height + 50_000 })) };
    const tx = fundedLockTx(pieces, [{ lockingScript: inscription(fake), satoshis: 1 }]);
    expect(checkLockTx(tx.toHex(), new Set(), 0).receiptValid).toBe(false);
  });
  test('a receipt with no lock outputs at all (just a picture) is rejected', () => {
    const tx = fundedLockTx([], [{ lockingScript: inscription(receipt), satoshis: 1 }]);
    const v = checkLockTx(tx.toHex(), new Set(), 0);
    expect(v.receiptValid).toBe(false);
    expect(v.status).toBe('No locks');
  });
  test('locks to someone else’s key do not match the receipt', () => {
    const other = PrivateKey.fromRandom().toAddress();
    const tx = new Transaction();
    tx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(address), sequence: 0xffffffff });
    for (const p of pieces) tx.addOutput({ lockingScript: Lock.lock(other, p.height), satoshis: p.sats });
    tx.addOutput({ lockingScript: inscription(receipt), satoshis: 1 });
    expect(checkLockTx(tx.toHex(), new Set(), 0).problems.join(' ')).toContain('different key');
  });
});

describe('percent tail re-split', () => {
  test('pays the due period and re-locks the rest in the next batch', async () => {
    const { resplitTail } = await import('./schedule');
    const all = percentAmounts(100_000_000, 0.01, 'original') as number[];
    const pending = all.slice(MAX_PIECES - 1);
    const r = resplitTail(pending, 1000, 'daily');
    expect(r.pieces).toHaveLength(MAX_PIECES);
    expect(r.pieces[0].height).toBe(1144);
    expect(r.pieces.at(-1)!.tail).toBe(true);
    const relocked = r.pieces.reduce((s, p) => s + p.sats, 0);
    expect(relocked + pending[0]).toBe(pending.reduce((s, a) => s + a, 0));
    const small = resplitTail([5000, 5000, 5000], 1000, 'weekly');
    expect(small.pieces.map((p) => p.height)).toEqual([2008, 3016]);
    expect(small.pendingAmounts).toEqual([]);
  });
});
