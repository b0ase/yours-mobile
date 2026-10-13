import { describe, expect, test } from 'bun:test';
import type { Transaction } from '@bsv/sdk';
import type { Fetch } from './names';
import { checkNames, orderForMinting, planBatch, runBatch, type BatchState } from './opnsBatch';
import { abortFailedAction, failedActionRef, type MintStepResult } from './opnsMint';
import { isDoubleSpend, mineName, type MineChar } from './opnsRegister';
import { OpnsTree } from './opnsTree';

// The owner's 13 Oct 2026 sequence: b0ase minted in 3 unconfirmed txs from indexer node "b0".
const B0_NODE = `65d93b0f${'0'.repeat(50)}d2902a.1`;
const T_B0A = `3a2e7a9e${'1'.repeat(56)}`;
const T_B0AS = `98aa160c${'2'.repeat(56)}`;
const T_B0ASE = `a222424d${'3'.repeat(56)}`;

const memKV = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const step = (txid: string, newDomain: string): MintStepResult => ({ txid, newDomain, childOutpoint: `${txid}.1` });

/** Tree after minting b0ase: b0 → b0a → b0as → b0ase, all unconfirmed. */
const mintedB0ase = (kv = memKV()) => {
  const t = new OpnsTree(kv, 'k');
  t.record(B0_NODE, 'b0', step(T_B0A, 'b0a'));
  t.record(`${T_B0A}.1`, 'b0a', step(T_B0AS, 'b0as'));
  t.record(`${T_B0AS}.1`, 'b0as', step(T_B0ASE, 'b0ase'));
  return { t, kv };
};

/** Indexer that only knows confirmed state: every lookup says node "b0", origins 404. */
const staleIndexer =
  (mine: () => { outpoint: string; domain: string } = () => ({ outpoint: B0_NODE, domain: 'b0' })): Fetch =>
  async (url) =>
    url.includes('/mine/')
      ? new Response(JSON.stringify(mine()), { status: 200 })
      : new Response('{}', { status: 404 });

const fakeNode = (outpoint: string, domain: string) => ({
  outpoint,
  beef: [],
  tx: {} as Transaction,
  vout: 1,
  state: { claimed: [0], domain, pow: new Array(32).fill(1) },
});
const domainOf: Record<string, string> = {
  [B0_NODE]: 'b0',
  [`${T_B0A}.1`]: 'b0a',
  [`${T_B0AS}.1`]: 'b0as',
  [`${T_B0ASE}.1`]: 'b0ase',
  [`${T_B0ASE}.0`]: 'b0as',
};
const instant: MineChar = async () => ({ nonce: new Array(32).fill(0), hash: new Array(32).fill(0) });

const run = (t: OpnsTree, f: Fetch, mint: (op: string, d: string) => MintStepResult, loads: string[] = []) =>
  mineName(
    {
      ctx: {} as never,
      fetch: f,
      tree: t,
      mineChar: instant,
      load: async (_c, op) => (loads.push(op), fakeNode(op, domainOf[op] ?? '?')),
      mint: async (_c, n, ch) => mint(n.outpoint, n.state.domain + String.fromCharCode(ch)),
    },
    'b0asex',
    new AbortController().signal,
    () => undefined,
  );

describe('OpNS local mine-tree (13 Oct double-spend bug)', () => {
  test('b0asex continues from our unconfirmed b0ase node and mines 1 char, not from the indexer\'s spent "b0"', async () => {
    const { t } = mintedB0ase();
    const spent: string[] = [];
    const loads: string[] = [];
    const steps = await run(t, staleIndexer(), (op, d) => (spent.push(op), step('e'.repeat(64), d)), loads);
    expect(loads).toEqual([`${T_B0ASE}.1`]);
    expect(spent).toEqual([`${T_B0ASE}.1`]);
    expect(steps.map((s) => s.newDomain)).toEqual(['b0asex']);
    expect(t.isSpent(B0_NODE)).toBe(true);
  });

  test('a node we know is spent is never reused, even when the indexer still offers it', async () => {
    const t = new OpnsTree(memKV(), 'k');
    t.markSpent(B0_NODE);
    let minted = 0;
    await expect(run(t, staleIndexer(), (_o, d) => (minted++, step('e'.repeat(64), d)))).rejects.toThrow('catching up');
    expect(minted).toBe(0);
  });

  test('resume after reload: a fresh cache from the same storage still knows the b0ase chain', async () => {
    const { kv } = mintedB0ase();
    const reloaded = new OpnsTree(kv, 'k');
    expect(reloaded.best('b0asex')?.outpoint).toBe(`${T_B0ASE}.1`);
    expect(reloaded.isOurs('b0ase')).toBe(true);
    const loads: string[] = [];
    await run(reloaded, staleIndexer(), (_o, d) => step('e'.repeat(64), d), loads);
    expect(loads).toEqual([`${T_B0ASE}.1`]);
  });

  test('WERR_REVIEW_ACTIONS on a mine step: node marked spent, retried once from a newer node', async () => {
    const t = new OpnsTree(memKV(), 'k');
    const NEW = `${'d'.repeat(64)}.1`;
    domainOf[NEW] = 'b0ase';
    let lookups = 0;
    const f = staleIndexer(() =>
      lookups++ < 2 ? { outpoint: B0_NODE, domain: 'b0' } : { outpoint: NEW, domain: 'b0ase' },
    );
    const tried: string[] = [];
    const steps = await run(t, f, (op, d) => {
      tried.push(op);
      if (op === B0_NODE) {
        const e = new Error('Undelayed createAction or signAction results require review.');
        e.name = 'WERR_REVIEW_ACTIONS';
        throw e;
      }
      return step('f'.repeat(64), d);
    });
    expect(tried).toEqual([B0_NODE, NEW]);
    expect(t.isSpent(B0_NODE)).toBe(true);
    expect(steps.at(-1)?.newDomain).toBe('b0asex');
  });

  test('a review failure with no newer node gives a clear message instead of looping', async () => {
    const t = new OpnsTree(memKV(), 'k');
    let calls = 0;
    await expect(
      run(t, staleIndexer(), () => {
        calls++;
        throw Object.assign(new Error('require review'), { name: 'WERR_REVIEW_ACTIONS' });
      }),
    ).rejects.toThrow('catching up');
    expect(calls).toBe(1);
  });

  test('a name we already minted (unconfirmed) is not mined again', async () => {
    const { t } = mintedB0ase();
    let minted = 0;
    const steps = await mineName(
      { ctx: {} as never, fetch: staleIndexer(), tree: t, mint: async () => (minted++, {} as never) },
      'b0ase',
      new AbortController().signal,
      () => undefined,
    );
    expect(steps).toEqual([]);
    expect(minted).toBe(0);
  });

  test('check + planner: unconfirmed b0ase is ours; b0asex plans 1 char from it, after b0ase', async () => {
    const { t } = mintedB0ase();
    const order = orderForMinting(['b0asex', 'b0ase']);
    expect(order).toEqual(['b0ase', 'b0asex']);
    const checks = await checkNames(staleIndexer(), order, () => false, t);
    expect(checks[0]).toEqual({ name: 'b0ase', state: 'mine' });
    const plan = planBatch(checks);
    expect(plan[1]).toMatchObject({ name: 'b0asex', state: 'free', from: 'b0ase', chars: 1 });
  });

  test('runBatch treats our in-flight names as ours, not free', async () => {
    const { t } = mintedB0ase();
    const start: BatchState = {
      v: 1,
      approvedSats: 0,
      createdAt: 0,
      items: [{ name: 'b0ase', status: 'pending', txids: [] }],
    };
    let mined = 0;
    const r = await runBatch(
      {
        fetch: staleIndexer(),
        mine: async () => (mined++, []),
        isMine: () => false,
        tree: t,
        save: () => undefined,
        onUpdate: () => undefined,
      },
      start,
      new AbortController().signal,
    );
    expect(mined).toBe(0);
    expect(r.state.items[0].status).toBe('mine');
  });

  test('failed action is aborted with its txid; review errors count as double-spends', async () => {
    const txid = 'bcf938b3'.padEnd(64, '4');
    expect(failedActionRef(Object.assign(new Error('x'), { txid }))).toBe(txid);
    const aborted: string[] = [];
    const ctx = {
      wallet: { abortAction: async (a: { reference: string }) => (aborted.push(a.reference), { aborted: true }) },
    };
    await abortFailedAction(ctx as never, new Error(`WERR_REVIEW_ACTIONS ${txid} failed`));
    expect(aborted).toEqual([txid]);
    expect(
      isDoubleSpend(Object.assign(new Error('Undelayed results require review'), { name: 'WERR_REVIEW_ACTIONS' })),
    ).toBe(true);
  });
});
