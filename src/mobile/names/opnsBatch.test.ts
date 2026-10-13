import { describe, expect, test } from 'bun:test';
import type { Fetch } from './names';
import {
  ALLOWANCE_USED_UP,
  checkNames,
  loadBatch,
  mintParam,
  newBatch,
  orderForMinting,
  parseNameList,
  planBatch,
  runBatch,
  saveBatch,
  serviceFeeUsd,
  type BatchState,
  type KV,
  type MineOne,
} from './opnsBatch';
import { MiningCancelled, NameTakenError } from './opnsRegister';

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

/** origin lookups answer "taken" for names in `taken`. */
const fakeFetch = (taken: Set<string>): Fetch =>
  (async (u: string) => {
    const name = decodeURIComponent(u.split('/').pop() ?? '');
    const body = u.includes('/origin/') && taken.has(name) ? { outpoint: `${'a'.repeat(64)}.2` } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as Fetch;

describe('parseNameList', () => {
  test('lines, commas, spaces; lowercase; dedupe; @/$ stripped; comments and blanks ignored', () => {
    const r = parseNameList('B0ase, b0asex\n\n# our names\n$bchat  @bchat\nbad_name\nbmail # inline\nhé');
    expect(r.names).toEqual(['b0ase', 'b0asex', 'bchat', 'bmail']);
    expect(r.invalid).toEqual(['bad_name', 'hé']);
  });
  test('?mint= param pre-fills one per line', () => {
    expect(parseNameList(mintParam('?mint=b0s,BCHAT,b0s')).names).toEqual(['b0s', 'bchat']);
    expect(mintParam('?x=1')).toBe('');
  });
});

describe('prefix ordering and planning', () => {
  test('alphabetical order mints prefixes first', () => {
    expect(orderForMinting(['bmoviesx', 'bmovies', 'b0asex', 'b0ase', 'b0s'])).toEqual([
      'b0ase',
      'b0asex',
      'b0s',
      'bmovies',
      'bmoviesx',
    ]);
  });
  test('later names reuse prefixes mined by earlier ones', () => {
    const plan = planBatch(
      ['bmail', 'bmint', 'bmovies', 'bmoviesx'].map((name) => ({ name, state: 'free' as const, domain: 'b' })),
    );
    expect(plan.map((p) => [p.name, p.from, p.chars])).toEqual([
      ['bmail', 'b', 4],
      ['bmint', 'bm', 3],
      ['bmovies', 'bm', 5],
      ['bmoviesx', 'bmovies', 1],
    ]);
  });
  test('taken / mine names cost nothing; the tree node wins when it is longer', () => {
    const plan = planBatch([
      { name: 'b0', state: 'taken' },
      { name: 'b0s', state: 'free', domain: 'b0' },
      { name: 'bcorp', state: 'mine' },
    ]);
    expect(plan.map((p) => p.chars)).toEqual([0, 1, 0]);
  });
  test('service fee only when an address is set', () => {
    expect(serviceFeeUsd(3, '')).toBe(0);
    expect(serviceFeeUsd(3, '1Fee')).toBe(3);
  });
});

const batchOf = (...names: string[]): BatchState =>
  newBatch(
    names.map((name) => ({ name, state: 'free' as const, domain: '', chars: name.length, from: '' })),
    100,
    0,
  );

describe('runBatch', () => {
  test('skips a name taken by the time it is mined, mines the rest', async () => {
    const mined: string[] = [];
    const mine: MineOne = async (n) => (mined.push(n), [{ txid: `tx-${n}` }]);
    const r = await runBatch(
      { fetch: fakeFetch(new Set(['b0s'])), mine, isMine: () => false, save: () => {}, onUpdate: () => {} },
      batchOf('b0ase', 'b0s', 'bchat'),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(mined).toEqual(['b0ase', 'bchat']);
    expect(r.state.items.map((i) => i.status)).toEqual(['done', 'skipped', 'done']);
    expect(r.state.items[0].txids).toEqual(['tx-b0ase']);
  });
  test('NameTakenError mid-mine skips; a wallet error stops with the name still pending', async () => {
    const mine: MineOne = async (n) => {
      if (n === 'a') throw new NameTakenError(n);
      if (n === 'b') throw new Error('Insufficient funds');
      return [{ txid: n }];
    };
    const r = await runBatch(
      { fetch: fakeFetch(new Set()), mine, isMine: () => false, save: () => {}, onUpdate: () => {} },
      batchOf('a', 'b', 'c'),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('error');
    expect(r.error).toBe('Insufficient funds');
    expect(r.state.items.map((i) => i.status)).toEqual(['skipped', 'pending', 'pending']);
  });
  test('resumes from persisted state after the window closed mid-mine', async () => {
    const kv = memKV();
    const id = '1Id';
    const first: string[] = [];
    // First run: 'a' done, then the window "closes" while mining 'b'.
    const r1 = await runBatch(
      {
        fetch: fakeFetch(new Set()),
        mine: async (n) => {
          first.push(n);
          if (n === 'b') throw new MiningCancelled();
          return [{ txid: n }];
        },
        isMine: () => false,
        save: (s) => saveBatch(id, s, kv),
        onUpdate: () => {},
      },
      batchOf('a', 'b', 'c'),
      new AbortController().signal,
    );
    expect(r1.stopped).toBe('cancelled');
    // Simulate a crash that left 'b' marked mining in storage.
    const raw = JSON.parse(kv.getItem(`bwallet.opnsBatch.${id}`)!) as BatchState;
    raw.items[1].status = 'mining';
    kv.setItem(`bwallet.opnsBatch.${id}`, JSON.stringify(raw));
    const loaded = loadBatch(id, kv)!;
    expect(loaded.items.map((i) => i.status)).toEqual(['done', 'pending', 'pending']);
    const second: string[] = [];
    const r2 = await runBatch(
      {
        fetch: fakeFetch(new Set()),
        mine: async (n) => (second.push(n), [{ txid: n }]),
        isMine: () => false,
        save: (s) => saveBatch(id, s, kv),
        onUpdate: () => {},
      },
      loaded,
      new AbortController().signal,
    );
    expect(second).toEqual(['b', 'c']);
    expect(r2.state.items.every((i) => i.status === 'done')).toBe(true);
    expect(loadBatch(id, kv)!.items.every((i) => i.status === 'done')).toBe(true);
  });
  test('Resume clears stale per-name errors (abiga: old unlock-length error) before retrying', async () => {
    const start = batchOf('aaron', 'abigail', 'zed');
    start.items[0].status = 'done';
    start.items[1].note = 'The args parameter must be spend unlockingScript length 12810 exceeds expected length 6337';
    start.items[2].status = 'error';
    start.items[2].note = 'old failure';
    const seen: (string | undefined)[][] = [];
    const r = await runBatch(
      {
        fetch: fakeFetch(new Set()),
        mine: async (n) => [{ txid: n }],
        isMine: () => false,
        save: () => {},
        onUpdate: (s) => seen.push(s.items.map((i) => i.note)),
      },
      start,
      new AbortController().signal,
    );
    expect(seen[0]).toEqual([undefined, undefined, undefined]);
    expect(r.state.items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
  });
  test('a name already in the wallet is marked mine, not mined; fee paid per mined name', async () => {
    const fees: string[] = [];
    const r = await runBatch(
      {
        fetch: fakeFetch(new Set()),
        mine: async (n) => [{ txid: n }],
        payFee: async (n) => (fees.push(n), `fee-${n}`),
        isMine: (n) => n === 'a',
        save: () => {},
        onUpdate: () => {},
      },
      batchOf('a', 'b'),
      new AbortController().signal,
    );
    expect(r.state.items.map((i) => i.status)).toEqual(['mine', 'done']);
    expect(fees).toEqual(['b']);
    expect(r.state.items[1].txids).toEqual(['b', 'fee-b']);
  });
});

describe('checkNames speed', () => {
  test('looks names up 8 at a time, streams each result, and caches answers', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const slow: Fetch = (async (u: string) => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      const name = decodeURIComponent(u.split('/').pop() ?? '');
      const body = u.includes('/origin/') ? (name.endsWith('0') ? { outpoint: `${'a'.repeat(64)}.2` } : {}) : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as Fetch;
    const names = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const seen: string[] = [];
    const t0 = Date.now();
    const out = await checkNames(slow, names, () => false, undefined, { onResult: (c) => seen.push(c.name) });
    const ms = Date.now() - t0;
    expect(out.map((c) => c.name)).toEqual(names);
    expect(out.filter((c) => c.state === 'taken').length).toBe(4);
    expect(seen.length).toBe(40);
    expect(peak).toBeGreaterThan(8); // 8 names at once, two lookups each
    expect(ms).toBeLessThan(40 * 2 * 20); // sequential took 1600ms here
    const before = calls;
    await checkNames(slow, names, () => false);
    expect(calls).toBe(before); // cached
  });
  test('backs off and retries on 429', async () => {
    let n = 0;
    const flaky: Fetch = (async () => {
      n++;
      return n <= 1 ? new Response('', { status: 429 }) : new Response('{}', { status: 200 });
    }) as Fetch;
    const [c] = await checkNames(flaky, ['zz-retry'], () => false);
    expect(c.state).toBe('free');
  });
});

describe('batch allowance', () => {
  test('one approval covers the batch up to its total +10%, then the run stops before overspending', async () => {
    const plan = planBatch([
      { name: 'aa', state: 'free', domain: '' },
      { name: 'bb', state: 'free', domain: '' },
      { name: 'cc', state: 'free', domain: '' },
    ]);
    // approved for 2 characters per name at 100 sats each = 600; cap 660
    const start = newBatch(plan, 600);
    let mines = 0;
    const mine: MineOne = async (n) => (
      mines++,
      n === 'aa' ? [{ txid: '1' }, { txid: '2' }, { txid: '3' }, { txid: '4' }] : [{ txid: '5' }, { txid: '6' }]
    );
    const r = await runBatch(
      { fetch: fakeFetch(new Set()), mine, isMine: () => false, save: () => {}, onUpdate: () => {}, perCharSats: 100 },
      start,
      new AbortController().signal,
    );
    // aa cost 400 (more than planned), bb 200 → 600 spent; cc needs 200 > 60 left
    expect(mines).toBe(2);
    expect(r.stopped).toBe('error');
    expect(r.error).toBe(ALLOWANCE_USED_UP);
    expect(r.state.spentSats).toBe(600);
    expect(r.state.items.map((i) => i.status)).toEqual(['done', 'done', 'pending']);
  });
});
