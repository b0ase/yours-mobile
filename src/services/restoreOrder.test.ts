/**
 * After a restore: plain BSV coins are checked first, newest first, and an unclear answer is a short retry that never
 * stops the run; three in a row stop the asking (task 69). Each coin gets exactly the per-coin checks it always had. Local only: fake-indexeddb for the admission list, an in-memory device store,
 * a stub chain. 3,000 outputs: 2,950 ordinals (oldest in the list) and 50 plain coins. Nothing here reaches a network.
 *
 * The stub counts chain calls and prices them as the real limit does (WhatsOnChain 3 a second app-wide) so a run's
 * time is measured, not guessed.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import { admissionListFor, admitPending, type InboundVerifier, type PendingAdmission } from './inboundSync';
import type { SpendState } from './unsentExpiry';

const ID = '02' + 'ab'.repeat(32);
const PLAIN = 50;
const ORDINALS = 2950;

type Chain = 'unspent' | 'spent' | 'unclear';

function build(opts: { unclearPlain?: Set<number>; spentPlain?: Set<number>; unknownPlain?: Set<number> }) {
  const sik = `sik-${Math.random()}`;
  const key = PrivateKey.fromRandom();
  const outputs: Record<string, unknown>[] = [];
  const txs: Record<string, unknown>[] = [];
  const answer = new Map<string, Chain>();
  const unknownTx = new Set<string>();
  const entries: PendingAdmission[] = [];
  const plainOps: string[] = [];
  const sleepy = new P2PKH().lock(key.toAddress());
  const t0 = Date.parse('2026-11-19T10:00:00Z');
  for (let i = 0; i < PLAIN + ORDINALS; i++) {
    const plain = i < PLAIN;
    const n = plain ? i : i - PLAIN;
    const tx = new Transaction();
    tx.addOutput({
      lockingScript: plain
        ? sleepy
        : Script.fromASM(`OP_0 OP_IF 6f7264 ${n.toString(16).padStart(8, '0')} OP_ENDIF OP_1`),
      satoshis: plain ? 1000 + n : 1,
    });
    const txid = tx.id('hex');
    txs.push({ transactionId: i + 1, userId: 1, txid, status: 'completed', rawTx: tx.toBinary() });
    outputs.push({
      outputId: i + 1,
      userId: 1,
      transactionId: i + 1,
      txid,
      vout: 0,
      satoshis: plain ? 1000 + n : 1,
      spendable: false,
      basketId: plain ? 1 : 2,
      lockingScript: Array.from(tx.outputs[0].lockingScript.toBinary()),
      type: plain ? 'P2PKH' : 'custom',
      change: plain,
      providedBy: 'storage',
      purpose: plain ? 'change' : '',
      derivationPrefix: plain ? 'p' : null,
      derivationSuffix: plain ? 's' : null,
      // Ordinals look newest by row time: the order must come from the kind of coin, not the clock.
      updated_at: new Date(t0 + (plain ? i : 10_000 + i) * 1000),
    });
    const op = `${txid}.0`;
    if (plain) {
      plainOps.push(op);
      answer.set(op, opts.spentPlain?.has(i) ? 'spent' : opts.unclearPlain?.has(i) ? 'unclear' : 'unspent');
      if (opts.unknownPlain?.has(i)) unknownTx.add(txid);
    } else answer.set(op, 'unspent');
    // Listed oldest first, ordinals before the plain coins: today's order checks the 2,950 ordinals first.
    entries.push({
      kind: 'coin',
      txid,
      vout: 0,
      key: `${ID}|coin|${op}`,
      identityKey: ID,
      firstAt: t0 + (plain ? 5000 + i : i),
      nextAt: t0 + (plain ? 5000 + i : i),
      tries: 0,
    });
  }
  const group = <T extends Record<string, unknown>>(rows: T[], k: string) => {
    const m = new Map<unknown, T[]>();
    for (const r of rows) m.set(r[k], [...(m.get(r[k]) ?? []), r]);
    return m;
  };
  const txByTxid = group(txs, 'txid');
  const outByTx = group(outputs, 'transactionId');
  const outByTxid = group(outputs, 'txid');
  const store = {
    getSettings: () => ({ storageIdentityKey: sik }),
    findUsers: async () => [{ userId: 1, identityKey: ID }],
    findOutputBaskets: async () => [
      { basketId: 1, name: 'default' },
      { basketId: 2, name: 'ordinals' },
    ],
    // Looked up by txid / transactionId first (as the real store's indexes do): a linear scan of 3,000 rows for each of
    // the run's thousands of reads made these tests take a minute and time out in a loaded full run (review A5).
    findTransactions: async (a: { partial: Record<string, unknown> }) =>
      (typeof a.partial.txid === 'string' ? (txByTxid.get(a.partial.txid) ?? []) : txs).filter((t) =>
        Object.entries(a.partial).every(([k, v]) => t[k] === v),
      ),
    findOutputs: async (a: { partial: Record<string, unknown> }) =>
      (typeof a.partial.transactionId === 'number'
        ? (outByTx.get(a.partial.transactionId) ?? [])
        : typeof a.partial.txid === 'string'
          ? (outByTxid.get(a.partial.txid) ?? [])
          : outputs
      ).filter((o) => Object.entries(a.partial).every(([k, v]) => o[k] === v)),
    transaction: async <T>(f: (trx: unknown) => Promise<T>) => f({}),
    updateOutput: async (id: number, u: Record<string, unknown>) => {
      Object.assign(outputs.find((o) => o.outputId === id)!, u);
      // The chain calls made by the moment the last plain coin became spendable.
      if (!plainDoneAt && outputs.filter((o) => o.spendable === true && o.basketId === 1).length === PLAIN)
        plainDoneAt = { ...calls };
    },
    updateTransaction: async () => undefined,
  };
  const calls = { single: 0, known: 0 };
  let plainDoneAt: typeof calls | undefined;
  const read = (op: string): SpendState => {
    const a = answer.get(op)!;
    return a === 'spent'
      ? { state: 'spent', by: 'ab'.repeat(32) }
      : a === 'unspent'
        ? { state: 'unspent' }
        : { state: 'unclear' };
  };
  const verifier: InboundVerifier = {
    owns: async () => true,
    spent: async (op) => (calls.single++, read(op)),
    txKnown: async (txid) => (calls.known++, unknownTx.has(txid) ? 'unknown' : 'known'),
    chainTx: async () => ({ state: 'unclear' }),
  };
  return { store, verifier, entries, outputs, answer, calls, sik, plainOps, t0, plainDone: () => plainDoneAt };
}

const spendableCount = (w: ReturnType<typeof build>, plain: boolean) =>
  w.outputs.filter((o) => o.spendable === true && (o.basketId === 1) === plain).length;

async function load(w: ReturnType<typeof build>) {
  const list = admissionListFor(w.sik);
  for (const e of w.entries) await list.put(e);
  return list;
}

/** Virtual seconds one run's chain calls take under the real limits. */
const seconds = (c: { single: number; known: number }, since: { single: number; known: number }) =>
  (c.single - since.single + (c.known - since.known)) / 3;

describe('task 69: after a restore, plain coins first', () => {
  test('with 3,000 outputs every plain coin is admitted in the first batch, and the time is measured', async () => {
    const w = build({});
    await load(w);
    // The scenario is the bad one: today's order (oldest first) puts no plain coin in the first batch.
    const oldFirst = [...w.entries].sort((a, b) => a.nextAt - b.nextAt).slice(0, 100);
    expect(oldFirst.some((e) => w.plainOps.includes(`${e.txid}.0`))).toBe(false);

    let runs = 0;
    let now = w.t0 + 60_000;
    while (spendableCount(w, true) < PLAIN && runs < 200) {
      const r = await admitPending(w.store as never, ID, w.verifier, { now: () => now });
      runs++;
      now += 1000;
      if (r.left === 0) break;
    }
    expect(spendableCount(w, true)).toBe(PLAIN);
    expect(runs).toBe(1); // one run of 100 entries covers all 50 plain coins
    // Chain time until the 50th plain coin was spendable: 50 coins × 2 WhatsOnChain calls (spent, then txKnown) at 3 a
    // second. The same per-coin checks as before; only the order changed.
    const zero = { single: 0, known: 0 };
    const virtual = seconds(w.plainDone()!, zero);
    expect(virtual).toBeLessThan(40);
    console.log(
      `[task 69] 50 plain coins spendable after ${runs} run, ${virtual.toFixed(1)} s of chain time (3,000 stub outputs; whole run ${seconds(w.calls, zero).toFixed(1)} s)`,
    );
  }, 60_000);

  test('an unclear answer is a short retry and never stops the rest of the run', async () => {
    const unclear = new Set([3, 7]);
    const w = build({ unclearPlain: unclear });
    await load(w);
    const now = w.t0 + 60_000;
    const r1 = await admitPending(w.store as never, ID, w.verifier, { now: () => now });
    expect(r1.deferred).toBe(true);
    expect(spendableCount(w, true)).toBe(PLAIN - 2); // the other 48 went on
    const list = await admissionListFor(w.sik).list(ID);
    const waits = list.filter((e) => w.plainOps.includes(`${e.txid}.0`));
    expect(waits.length).toBe(2);
    for (const e of waits) expect(e.nextAt - now).toBe(5_000); // 5 s, not 60 s
    // Still unclear: 15 s. Then the chain answers: admitted.
    const r2 = await admitPending(w.store as never, ID, w.verifier, { now: () => now + 5_000 });
    expect(r2.deferred).toBe(true);
    expect(spendableCount(w, true)).toBe(PLAIN - 2);
    const again = (await admissionListFor(w.sik).list(ID)).filter((e) => w.plainOps.includes(`${e.txid}.0`));
    for (const e of again) expect(e.nextAt - (now + 5_000)).toBe(15_000);
    for (const i of unclear) w.answer.set(w.plainOps[i], 'unspent');
    await admitPending(w.store as never, ID, w.verifier, { now: () => now + 20_000 });
    expect(spendableCount(w, true)).toBe(PLAIN);
  }, 60_000); // real fake-indexeddb work for 3,000 entries: over bun's 5 s default in a loaded full run (review A5)

  test('a coin the chain says is spent, or whose transaction is unknown, is still not admitted', async () => {
    const w = build({ spentPlain: new Set([1]), unknownPlain: new Set([2]) });
    await load(w);
    const now = w.t0 + 60_000;
    await admitPending(w.store as never, ID, w.verifier, { now: () => now });
    const spendable = new Set(w.outputs.filter((o) => o.spendable === true).map((o) => `${o.txid}.${o.vout}`));
    expect(spendable.has(w.plainOps[1])).toBe(false);
    expect(spendable.has(w.plainOps[2])).toBe(false);
    expect(spendableCount(w, true)).toBe(PLAIN - 2);
    expect(w.calls.single).toBe(100); // every coin of the run asked one by one
  }, 60_000);

  test('the tokens-and-names tail still drains: every batch after is ordinals, each checked', async () => {
    const w = build({});
    await load(w);
    const now = w.t0 + 60_000;
    let runs = 0;
    while (runs < 40) {
      const r = await admitPending(w.store as never, ID, w.verifier, { now: () => now });
      runs++;
      if (r.left === 0) break;
    }
    expect(spendableCount(w, false)).toBe(ORDINALS);
    expect(runs).toBe(30); // 3,000 / 100, a bounded number of batches
  }, 120_000);
});

describe('task 69 review: a WhatsOnChain outage stops the run', () => {
  test('A4: three unclear answers in a row and the run asks nothing more; the rest wait 5 s', async () => {
    const all = new Set(Array.from({ length: PLAIN }, (_, i) => i));
    const w = build({ unclearPlain: all });
    await load(w);
    const start = w.t0 + 60_000;
    const r = await admitPending(w.store as never, ID, w.verifier, { now: () => start });
    expect(r.deferred).toBe(true);
    expect(w.calls.single + w.calls.known).toBe(3); // was 100: one per coin, every run, during the outage
    const plain = (await admissionListFor(w.sik).list(ID)).filter((e) => w.plainOps.includes(`${e.txid}.0`));
    expect(plain.length).toBe(PLAIN);
    for (const e of plain) expect(e.nextAt - start).toBe(5_000);
    expect(plain.filter((e) => e.tries === 1).length).toBe(3); // only the three asked count a try
    // WhatsOnChain is back: the next run goes through, a clear answer resets the count.
    for (const i of all) w.answer.set(w.plainOps[i], 'unspent');
    await admitPending(w.store as never, ID, w.verifier, { now: () => start + 5_000 });
    expect(spendableCount(w, true)).toBe(PLAIN);
  }, 60_000);
});
