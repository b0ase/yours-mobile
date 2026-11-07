import { describe, expect, test } from 'bun:test';
import {
  armCoinPreflight,
  checkApplies,
  checkCoins,
  installCoinPreflight,
  plannedCoins,
  SpentElsewhereError,
  withoutOwnSpenders,
  wocSpentStatus,
  type PreflightCoin,
  type PreflightReport,
} from './coinPreflight';
import {
  SPENT_ELSEWHERE_MESSAGE,
  SPENT_ELSEWHERE_SHORT_MESSAGE,
  SPENT_ELSEWHERE_STUCK_MESSAGE,
} from '../utils/sendErrors';

const T = (c: string) => c.repeat(64);
const A = `${T('a')}_0`;
const B = `${T('b')}_1`;
const C = `${T('c')}_2`;
const coin = (outpoint: string, satoshis = 1000): PreflightCoin => ({ outpoint, satoshis });
const never = <X>() => new Promise<X>(() => undefined);

describe('checkCoins: the automatic check’s rule (two sources, or a mined spend)', () => {
  const run = (
    index: (string | null)[] | null,
    woc: Record<string, { txid: string; confirmed: boolean } | null | 'err'>,
  ) =>
    checkCoins([coin(A)], {
      index: async () => {
        if (!index) throw new Error('down');
        return index;
      },
      woc: async (o) => {
        const w = woc[o];
        if (w === 'err') throw new Error('woc 500');
        return w ?? null;
      },
    });

  test('index and WhatsOnChain name the same spender (mempool counts): spent', async () => {
    const r = await run([T('9')], { [A]: { txid: T('9'), confirmed: false } });
    expect(r.spent).toEqual([{ outpoint: A, spender: T('9'), confirmed: false }]);
  });
  test('txids compare case-insensitively', async () => {
    const r = await run([T('9').toUpperCase()], { [A]: { txid: T('9'), confirmed: false } });
    expect(r.spent.map((s) => s.spender)).toEqual([T('9')]);
  });
  test('WhatsOnChain names a MINED spender, index silent or down: spent', async () => {
    expect((await run([null], { [A]: { txid: T('9'), confirmed: true } })).spent).toHaveLength(1);
    expect((await run(null, { [A]: { txid: T('9'), confirmed: true } })).spent).toHaveLength(1);
  });
  test('one unconfirmed source alone is never enough: suspect, not spent', async () => {
    for (const r of [
      await run([null], { [A]: { txid: T('9'), confirmed: false } }), // WhatsOnChain mempool only
      await run(null, { [A]: { txid: T('9'), confirmed: false } }), // index down, WhatsOnChain mempool
      await run([T('9')], { [A]: null }), // index only, WhatsOnChain says unspent
      await run([T('9')], { [A]: 'err' }), // index only, WhatsOnChain can't tell
      await run([T('9')], { [A]: { txid: T('8'), confirmed: false } }), // they disagree
    ]) {
      expect(r.spent).toEqual([]);
      expect(r.suspect).toEqual([A]);
    }
  });
  test('both unspent: nothing; neither answers: unknown (the send goes ahead as before)', async () => {
    expect(await run([null], { [A]: null })).toMatchObject({ spent: [], suspect: [], unknown: [] });
    expect(await run(null, { [A]: 'err' })).toMatchObject({ spent: [], suspect: [], unknown: [A] });
  });
  test('an index reply of the wrong length is treated as no answer', async () => {
    const r = await checkCoins([coin(A), coin(B)], {
      index: async () => [T('9')],
      woc: async () => null,
    });
    expect(r.spent).toEqual([]);
    expect(r.suspect).toEqual([]);
  });
  test('a hung lookup times out quickly and fails open', async () => {
    const t0 = Date.now();
    const r = await checkCoins([coin(A)], { index: never, woc: never, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.unknown).toEqual([A]);
  });
  test('the WhatsOnChain request is aborted when it times out', async () => {
    let aborted = false;
    await checkCoins([coin(A)], {
      woc: (_o, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      timeoutMs: 20,
    });
    expect(aborted).toBe(true);
  });
  test('WhatsOnChain: the biggest coins first, at most maxWoc', async () => {
    const asked: string[] = [];
    await checkCoins([coin(A, 10), coin(B, 1000), coin(C, 100)], {
      index: async (ops) => ops.map(() => null),
      woc: async (o) => (asked.push(o), null),
      maxWoc: 2,
    });
    expect(asked).toEqual([B, C]);
  });
  test('one batched index call for all coins, run beside WhatsOnChain', async () => {
    const batches: string[][] = [];
    await checkCoins([coin(A), coin(B)], {
      index: async (ops) => (batches.push(ops), [null, null]),
      woc: async () => null,
    });
    expect(batches).toEqual([[A, B]]);
  });
});

describe('withoutOwnSpenders', () => {
  test("a spender that is this wallet's own unfinished or failed action is not 'spent elsewhere'", () => {
    const r: PreflightReport = {
      checked: 2,
      spent: [
        { outpoint: A, spender: T('1'), confirmed: false },
        { outpoint: B, spender: T('2'), confirmed: true },
      ],
      suspect: [C],
      unknown: [],
    };
    expect(withoutOwnSpenders(r, new Set([T('1')]))).toEqual({
      checked: 2,
      spent: [{ outpoint: B, spender: T('2'), confirmed: true }],
      suspect: [C, A],
      unknown: [],
    });
    expect(withoutOwnSpenders(r, new Set())).toBe(r);
  });
});

describe('wocSpentStatus', () => {
  const call = async (status: number, body?: unknown) => {
    const urls: string[] = [];
    const f = (async (u: string) => (
      urls.push(u),
      new Response(body ? JSON.stringify(body) : '', { status })
    )) as unknown as typeof fetch;
    const r = await wocSpentStatus(`${T('a')}_3`, undefined, f).then(
      (x) => ({ ok: x }),
      (e: Error) => ({ err: e.message }),
    );
    return { urls, r };
  };
  test('asks exactly /v1/bsv/main/tx/{txid}/{vout}/spent (never the broken /out/ route)', async () => {
    const { urls } = await call(404);
    expect(urls).toEqual([`https://api.whatsonchain.com/v1/bsv/main/tx/${T('a')}/3/spent`]);
  });
  test('404 = unspent; 200 with a spender = spent (mempool or mined); anything else = can’t tell', async () => {
    expect((await call(404)).r).toEqual({ ok: null });
    expect((await call(200, { txid: T('9'), vin: 0, status: 'unconfirmed' })).r).toEqual({
      ok: { txid: T('9'), confirmed: false },
    });
    expect((await call(200, { txid: T('9'), vin: 0, status: 'confirmed' })).r).toEqual({
      ok: { txid: T('9'), confirmed: true },
    });
    expect('err' in (await call(500)).r).toBe(true);
    expect('err' in (await call(429)).r).toBe(true);
    expect('err' in (await call(200, {})).r).toBe(true);
  });
  test('refuses a malformed outpoint without a request', async () => {
    let n = 0;
    const f = (async () => (n++, new Response('', { status: 404 }))) as unknown as typeof fetch;
    await expect(wocSpentStatus('nope', undefined, f)).rejects.toThrow();
    expect(n).toBe(0);
  });
});

describe('checkApplies / plannedCoins', () => {
  const own = { bwxWalletOriginated: true, inputs: [], isNoSend: false, isSignAction: false };
  test("only the wallet's own send, funded by storage, signed and sent by the wallet, while a scope is held", () => {
    expect(checkApplies(own, true)).toBe(true);
    expect(checkApplies({ ...own, isDelayed: true } as never, true)).toBe(true);
    expect(checkApplies(own, false)).toBe(false);
    expect(checkApplies({ ...own, bwxWalletOriginated: false }, true)).toBe(false); // a site
    expect(checkApplies({ ...own, bwxWalletOriginated: undefined }, true)).toBe(false);
    expect(checkApplies({ ...own, inputs: [{}] }, true)).toBe(false);
    expect(checkApplies({ ...own, isNoSend: true }, true)).toBe(false);
    expect(checkApplies({ ...own, isSignAction: true }, true)).toBe(false);
    expect(checkApplies(undefined, true)).toBe(false);
  });
  test('plannedCoins reads storage’s inputs as "txid_vout" with their value', () => {
    expect(
      plannedCoins({
        inputs: [
          { sourceTxid: T('A'), sourceVout: 4, sourceSatoshis: 49_634_148 },
          { sourceTxid: 'bad', sourceVout: 1 },
        ],
      }),
    ).toEqual([{ outpoint: `${T('a')}_4`, satoshis: 49_634_148 }]);
  });
});

/** A storage manager stand-in: each createAction picks the next plan; abortAction records references. */
function fakeStorage(plans: (string[] | Error)[]) {
  const calls = { create: 0, aborted: [] as string[] };
  const s = {
    createAction: async () => {
      const p = plans[Math.min(calls.create, plans.length - 1)];
      calls.create++;
      if (p instanceof Error) throw p;
      return {
        reference: `ref${calls.create}`,
        inputs: p.map((o) => ({
          sourceTxid: o.split('_')[0],
          sourceVout: Number(o.split('_')[1]),
          sourceSatoshis: 1000,
        })),
      };
    },
    abortAction: async ({ reference }: { reference: string }) => (calls.aborted.push(reference), { aborted: true }),
  };
  return { s, calls };
}
const ownArgs = { bwxWalletOriginated: true, inputs: [], isNoSend: false, isSignAction: false };
const reportFor =
  (spent: string[]) =>
  async (coins: PreflightCoin[]): Promise<PreflightReport> => ({
    checked: coins.length,
    spent: coins
      .filter((c) => spent.includes(c.outpoint))
      .map((c) => ({ outpoint: c.outpoint, spender: T('9'), confirmed: false })),
    suspect: [],
    unknown: [],
  });

describe('installCoinPreflight', () => {
  const install = (
    s: unknown,
    spent: string[],
    o: {
      marks?: string[][];
      isLocal?: boolean;
      check?: () => Promise<PreflightReport>;
      markSpent?: () => Promise<number>;
    } = {},
  ) =>
    installCoinPreflight(s, {
      check: o.check ?? reportFor(spent),
      markSpent: o.markSpent ?? (async (sc) => (o.marks?.push(sc.map((c) => c.outpoint)), sc.length)),
      isLocal: () => o.isLocal ?? true,
      log: () => undefined,
    });
  const create = (s: { createAction: (a: unknown) => Promise<unknown> }, armed = true) => {
    const scope = armCoinPreflight(armed);
    return s.createAction(ownArgs).finally(() => scope.done());
  };

  test('no scope held: storage’s plan as is, no lookups', async () => {
    const { s, calls } = fakeStorage([[A]]);
    let checked = 0;
    install(s, [A], { check: async () => (checked++, reportFor([A])([])) });
    await create(s, false);
    expect(checked).toBe(0);
    expect(calls.aborted).toEqual([]);
  });
  test('clean coins: the plan goes on untouched', async () => {
    const { s, calls } = fakeStorage([[A, B]]);
    install(s, []);
    const r = (await create(s)) as { reference: string };
    expect(r.reference).toBe('ref1');
    expect(calls).toEqual({ create: 1, aborted: [] });
  });
  test('a spent coin: abort this plan, clear the coin, pick again once', async () => {
    const { s, calls } = fakeStorage([
      [A, B],
      [B, C],
    ]);
    const marks: string[][] = [];
    install(s, [A], { marks });
    const scope = armCoinPreflight(true);
    const r = (await s.createAction(ownArgs).finally(() => scope.done())) as { reference: string };
    expect(r.reference).toBe('ref2');
    expect(calls.aborted).toEqual(['ref1']);
    expect(marks).toEqual([[A]]);
    expect(scope.cleared).toBe(1);
  });
  test('the second pick has a spent coin too: stop, nothing signed, "try again"', async () => {
    const { s, calls } = fakeStorage([[A], [B], [C]]);
    install(s, [A, B]);
    const err = await create(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpentElsewhereError);
    expect((err as SpentElsewhereError).message).toBe(SPENT_ELSEWHERE_MESSAGE);
    expect((err as SpentElsewhereError).cleared).toEqual([A, B]);
    expect(calls).toEqual({ create: 2, aborted: ['ref1', 'ref2'] });
  });
  test('not enough left after clearing: the short message', async () => {
    const short = Object.assign(new Error('Insufficient funds in the available inputs'), {
      name: 'WERR_INSUFFICIENT_FUNDS',
    });
    const { s } = fakeStorage([[A], short]);
    install(s, [A]);
    const err = (await create(s).catch((e: unknown) => e)) as SpentElsewhereError;
    expect(err.short).toBe(true);
    expect(err.message).toBe(SPENT_ELSEWHERE_SHORT_MESSAGE);
    expect(err.message).not.toMatch(/Insufficient funds/i); // never mistaken for the stale funding message
  });
  test('any other error on the second pick is passed on as is', async () => {
    const other = new Error('A truthy value is required.');
    const { s } = fakeStorage([[A], other]);
    install(s, [A]);
    expect(await create(s).catch((e: unknown) => e)).toBe(other);
  });
  test('fail open: a check that throws, or an abort that fails, sends exactly as before', async () => {
    const a = fakeStorage([[A]]);
    install(a.s, [], { check: async () => Promise.reject(new Error('boom')) });
    expect(((await create(a.s)) as { reference: string }).reference).toBe('ref1');
    const b = fakeStorage([[A]]);
    b.s.abortAction = async () => Promise.reject(new Error('locked'));
    const marks: string[][] = [];
    install(b.s, [A], { marks });
    expect(((await create(b.s)) as { reference: string }).reference).toBe('ref1');
    expect(marks).toEqual([]); // the coin stays as it is when its plan can't be released
  });
  test('an abort the toolbox refuses ({aborted:false}, no throw) is a failed abort: sends as before (review 17, F7)', async () => {
    const { s, calls } = fakeStorage([[A], [B]]);
    s.abortAction = async ({ reference }: { reference: string }) => (calls.aborted.push(reference), { aborted: false });
    const marks: string[][] = [];
    install(s, [A], { marks });
    expect(((await create(s)) as { reference: string }).reference).toBe('ref1');
    expect(marks).toEqual([]);
    expect(calls.create).toBe(1); // never picked again over a plan that still holds the coins
  });
  test('the spent coins could not be marked: a real error, not the looping "try again" (review 17, F6)', async () => {
    for (const markSpent of [async () => 0, async () => Promise.reject(new Error('storage busy'))]) {
      const { s, calls } = fakeStorage([[A], [A]]);
      install(s, [A], { markSpent });
      const err = await create(s).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpentElsewhereError);
      expect((err as SpentElsewhereError).kind).toBe('stuck');
      expect((err as Error).message).toBe(SPENT_ELSEWHERE_STUCK_MESSAGE);
      expect(calls.create).toBe(1); // not picked again: it would choose the same dead coin
    }
  });
  test('the remote store active: never checked', async () => {
    const { s, calls } = fakeStorage([[A]]);
    install(s, [A], { isLocal: false });
    await create(s);
    expect(calls.aborted).toEqual([]);
  });
  test('installs once; nothing to wrap returns false', () => {
    const { s } = fakeStorage([[A]]);
    expect(install(s, [])).toBe(true);
    const wrapped = s.createAction;
    expect(install(s, [])).toBe(true);
    expect(s.createAction).toBe(wrapped);
    expect(install({}, [])).toBe(false);
    expect(install(null, [])).toBe(false);
  });
});
