import { describe, expect, test } from 'bun:test';
import type { WalletOutput } from '@bsv/sdk';
import type { Fetch } from './names';
import { checkNames, newBatch, runBatch, type KV } from './opnsBatch';
import {
  fetchAllOpnsListings,
  fetchOpnsListings,
  filterListings,
  listingSats,
  loadAutoList,
  saveAutoList,
  loadSellBatch,
  newSellBatch,
  ownedForSale,
  runSellBatch,
  saveSellBatch,
  searchLabel,
  sellRemaining,
  sellTotals,
  type SellItem,
  type SellState,
} from './opnsSell';

const memKV = (): KV => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const out = (outpoint: string, tags: string[]) => ({ outpoint, satoshis: 1, spendable: true, tags }) as WalletOutput;
const TX = 'a'.repeat(64);

describe('price conversion', () => {
  test('$1 at $50/BSV = 2,000,000 sats; rounds up; no rate → null', () => {
    expect(listingSats(1, 50)).toBe(2_000_000);
    expect(listingSats(1, 30)).toBe(3_333_334);
    expect(listingSats(1, 0)).toBeNull();
    expect(listingSats(0, 50)).toBeNull();
  });
  test('batch fixes sats at the approved rate, per-name override, totals', () => {
    const b = newSellBatch(
      [
        { name: 'alpha', id: 'i1' },
        { name: 'beta', id: 'i2' },
      ],
      50,
      { beta: 2.5 },
      123,
    );
    expect(b?.items.map((i) => [i.name, i.usd, i.sats, i.status])).toEqual([
      ['alpha', 1, 2_000_000, 'pending'],
      ['beta', 2.5, 5_000_000, 'pending'],
    ]);
    expect(sellTotals(b as SellState)).toEqual({ count: 2, sats: 7_000_000, usd: 3.5 });
    expect(newSellBatch([{ name: 'a', id: 'x' }], 0)).toBeNull();
    expect(newSellBatch([], 50)).toBeNull();
  });
});

describe('selection', () => {
  test('ownedForSale: names from tags, listed state + price, listed output wins, sorted', () => {
    const r = ownedForSale([
      out(`${TX}.1`, ['name:zed', 'id:z1']),
      out(`${TX}.2`, ['name:abc', 'id:a1']),
      out(`${TX}.3`, ['name:abc', 'id:a2', 'ordlock2', 'price:2000000']),
      out(`${TX}.4`, ['no-name']),
    ]);
    expect(r).toEqual([
      { name: 'abc', id: 'a2', listedSats: 2_000_000 },
      { name: 'zed', id: 'z1', listedSats: null },
    ]);
  });
});

describe('batching + resume', () => {
  const mk = () =>
    newSellBatch(
      ['a', 'b', 'c'].map((n) => ({ name: n, id: `id-${n}` })),
      50,
      // One-letter names have no tier price (offers only): price them explicitly here.
      { a: 1, b: 1, c: 1 },
    ) as SellState;

  test('lists in order, one at a time, saving after each step', async () => {
    const calls: string[] = [];
    const saves: SellState[] = [];
    const r = await runSellBatch(
      {
        list: async (it: SellItem) => {
          calls.push(`${it.id}@${it.sats}`);
          return `tx-${it.name}`;
        },
        isListed: () => false,
        save: (s) => saves.push(s),
        onUpdate: () => undefined,
      },
      mk(),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(calls).toEqual(['id-a@2000000', 'id-b@2000000', 'id-c@2000000']);
    expect(r.state.items.map((i) => i.txid)).toEqual(['tx-a', 'tx-b', 'tx-c']);
    expect(sellRemaining(r.state)).toBe(0);
    expect(saves.length).toBe(6);
  });

  test('error stops with the name pending + note; resume from storage skips done and already-listed', async () => {
    const kv = memKV();
    const save = (s: SellState) => saveSellBatch('addr', s, kv);
    const first = await runSellBatch(
      {
        list: async (it) => {
          if (it.name === 'b') throw new Error('Insufficient funds');
          return `tx-${it.name}`;
        },
        isListed: () => false,
        save,
        onUpdate: () => undefined,
      },
      mk(),
      new AbortController().signal,
    );
    expect(first.stopped).toBe('error');
    expect(first.state.items.map((i) => i.status)).toEqual(['done', 'pending', 'pending']);
    expect(first.state.items[1].note).toBe('Insufficient funds');

    const loaded = loadSellBatch('addr', kv) as SellState;
    expect(sellRemaining(loaded)).toBe(2);
    const calls: string[] = [];
    const second = await runSellBatch(
      {
        list: async (it) => {
          calls.push(it.name);
          return `tx-${it.name}`;
        },
        isListed: (n) => n === 'b',
        save,
        onUpdate: () => undefined,
      },
      loaded,
      new AbortController().signal,
    );
    expect(second.stopped).toBe('finished');
    expect(calls).toEqual(['c']);
    expect(second.state.items[1]).toMatchObject({ status: 'done', note: 'Already listed' });
  });

  test('a window closed mid-listing loads that name as pending; abort stops before the next', async () => {
    const kv = memKV();
    const s = mk();
    s.items[0].status = 'listing';
    saveSellBatch('addr', s, kv);
    expect(loadSellBatch('addr', kv)?.items[0].status).toBe('pending');
    const ctl = new AbortController();
    ctl.abort();
    const r = await runSellBatch(
      { list: async () => 'x', isListed: () => false, save: () => undefined, onUpdate: () => undefined },
      mk(),
      ctl.signal,
    );
    expect(r.stopped).toBe('cancelled');
    saveSellBatch('addr', null, kv);
    expect(loadSellBatch('addr', kv)).toBeNull();
  });
});

describe('listing retries (aaro: WERR_REVIEW_ACTIONS after aar listed)', () => {
  const REVIEW = 'Undelayed createAction or signAction results require review.';
  const mk2 = () =>
    newSellBatch(
      [
        { name: 'aarzz', id: 'i1' },
        { name: 'aarox', id: 'i2' },
      ],
      50,
      {},
      1,
    ) as SellState;
  test('a refused broadcast is retried after a pause and the batch carries on', async () => {
    let n = 0;
    const slept: number[] = [];
    const r = await runSellBatch(
      {
        list: async (it) => {
          if (it.name === 'aarox' && n++ === 0) throw new Error(REVIEW);
          return `tx-${it.name}`;
        },
        isListed: () => false,
        save: () => undefined,
        onUpdate: () => undefined,
        sleep: async (ms) => void slept.push(ms),
      },
      mk2(),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(r.state.items.map((i) => i.txid)).toEqual(['tx-aarzz', 'tx-aarox']);
    expect(slept.length).toBe(1);
  });
  test('never lists twice: a refused attempt that actually went out is marked listed', async () => {
    let listed = false;
    const r = await runSellBatch(
      {
        list: async (it) => {
          if (it.name === 'aarox') {
            listed = true;
            throw new Error(REVIEW);
          }
          return 'tx';
        },
        isListed: (name) => name === 'aarox' && listed,
        save: () => undefined,
        onUpdate: () => undefined,
        sleep: async () => undefined,
      },
      mk2(),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(r.state.items[1].note).toBe('Already listed');
  });
  test('still failing after the retries stops cleanly with the name pending for Resume', async () => {
    const r = await runSellBatch(
      {
        list: async (it) => {
          if (it.name === 'aarox') throw new Error(REVIEW);
          return 'tx';
        },
        isListed: () => false,
        save: () => undefined,
        onUpdate: () => undefined,
        sleep: async () => undefined,
      },
      mk2(),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('error');
    expect(r.state.items[1].status).toBe('pending');
  });
});

describe('search states', () => {
  const fmt = (sats: number) => `$${(sats / 2_000_000).toFixed(2)}`;
  test('free / mine / listed → Buy for $X / taken; store edition never offers Buy', () => {
    expect(searchLabel({ state: 'free' }, fmt, true)).toEqual({ kind: 'free', label: 'Free' });
    expect(searchLabel({ state: 'mine' }, fmt, true).kind).toBe('mine');
    expect(searchLabel({ state: 'taken', listing: { priceSats: 2_000_000 } }, fmt, true)).toEqual({
      kind: 'buy',
      label: 'Buy for $1.00',
    });
    expect(searchLabel({ state: 'taken', listing: { priceSats: 2_000_000 } }, fmt, false)).toEqual({
      kind: 'taken',
      label: 'Taken',
    });
    expect(searchLabel({ state: 'taken' }, fmt, true)).toEqual({ kind: 'taken', label: 'Taken' });
  });

  test('checkNames attaches the listing to taken names only', async () => {
    const taken = new Set(['sold', 'held']);
    const f = (async (u: string) => {
      const name = decodeURIComponent(u.split('/').pop() ?? '');
      const body = u.includes('/origin/') && taken.has(name) ? { outpoint: `${TX}.0` } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as Fetch;
    const listingOf = async (n: string) => (n === 'sold' ? { outpoint: `${TX}.5`, priceSats: 2_000_000 } : null);
    const r = await checkNames(f, ['sold', 'held', 'fresh'], () => false, undefined, { listingOf });
    expect(r).toEqual([
      { name: 'sold', state: 'taken', listing: { outpoint: `${TX}.5`, priceSats: 2_000_000 } },
      { name: 'held', state: 'taken' },
      { name: 'fresh', state: 'free', domain: null },
    ]);
  });
});

describe('order book', () => {
  test('maps 1Sat rows, drops nameless/other types/dupes, cheapest first; search filters', async () => {
    const rows = [
      {
        outpoint: `${TX}_1`,
        data: {
          ordlock: {
            name: 'Beta',
            origin: `${TX}_9`,
            price: 3_000_000,
            seller: '1abc',
            content_type: 'application/op-ns',
          },
        },
      },
      {
        outpoint: `${TX}_2`,
        data: { ordlock: { name: 'alpha', price: 2_000_000, content_type: 'application/op-ns' } },
      },
      { outpoint: `${TX}_3`, data: { ordlock: { name: '', price: 1 } } },
      { outpoint: `${TX}_4`, data: { ordlock: { name: 'pic', price: 5, content_type: 'image/png' } } },
      { outpoint: `${TX}_5`, data: { ordlock: { name: 'alpha', price: 9 } } },
    ];
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as Fetch;
    const l = await fetchOpnsListings(f);
    expect(url).toContain('type=application/op-ns');
    expect(l.map((x) => [x.name, x.priceSats, x.outpoint])).toEqual([
      ['alpha', 2_000_000, `${TX}.2`],
      ['beta', 3_000_000, `${TX}.1`],
    ]);
    expect(filterListings(l, '@ALP').map((x) => x.name)).toEqual(['alpha']);
    expect(filterListings(l, 'a').map((x) => x.name)).toEqual(['alpha', 'beta']);
    expect(filterListings(l, '').length).toBe(2);
    const bad = (async () => new Response('x', { status: 502 })) as Fetch;
    await expect(fetchOpnsListings(bad)).rejects.toThrow('502');
  });

  test('fetchAllOpnsListings follows the from=<score> cursor until a page adds nothing', async () => {
    const row = (name: string, score: number) => ({
      outpoint: `${TX}_${score}`,
      score,
      data: { ordlock: { name, price: 10 } },
    });
    const pages: Record<string, unknown[]> = {
      '': [row('a', 30), row('b', 20)],
      '20': [row('b', 20), row('c', 10)],
      '10': [row('c', 10)],
    };
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      const from = /from=(\d+)/.exec(u)?.[1] ?? '';
      return new Response(JSON.stringify(pages[from] ?? []), { status: 200 });
    }) as Fetch;
    const l = await fetchAllOpnsListings(f);
    expect(l.map((x) => x.name)).toEqual(['a', 'b', 'c']);
    expect(urls.length).toBe(3);
  });
});

describe('auto-list after mint', () => {
  const free = (async () => new Response('{}', { status: 200 })) as Fetch;
  const plan = (names: string[]) =>
    names.map((name) => ({ name, state: 'free' as const, domain: '', chars: name.length, from: '' }));

  test('lists each minted name; a listing failure marks it not listed and minting carries on', async () => {
    const mined: string[] = [];
    const r = await runBatch(
      {
        fetch: free,
        mine: async (n) => {
          mined.push(n);
          return [{ txid: `mint-${n}` }];
        },
        afterMint: async (n) => {
          if (n === 'bb') throw new Error('no funds');
          return `list-${n}`;
        },
        isMine: () => false,
        save: () => undefined,
        onUpdate: () => undefined,
      },
      newBatch(plan(['aa', 'bb', 'cc']), 0),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(mined).toEqual(['aa', 'bb', 'cc']);
    expect(r.state.items.map((i) => [i.name, i.status, i.listed])).toEqual([
      ['aa', 'done', true],
      ['bb', 'done', false],
      ['cc', 'done', true],
    ]);
    expect(r.state.items[0].txids).toEqual(['mint-aa', 'list-aa']);
    expect(r.state.items[1].note).toBe('Not listed: no funds');
  });

  test('auto-list setting defaults on and is remembered', () => {
    const kv = memKV();
    expect(loadAutoList(kv)).toBe(true);
    saveAutoList(false, kv);
    expect(loadAutoList(kv)).toBe(false);
    saveAutoList(true, kv);
    expect(loadAutoList(kv)).toBe(true);
  });
});
