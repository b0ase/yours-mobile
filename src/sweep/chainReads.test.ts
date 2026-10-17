import { describe, expect, test } from 'bun:test';
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk';
import { createChainReader, createScheduler, createTxCache, HttpError, isTransient } from './chainReads';

const noSleep = async () => {};

const tx = (n: number) => {
  const t = new Transaction();
  t.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: n,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(n + 1).toAddress()), satoshis: n + 1 });
  return t;
};

const memStore = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
};

describe('scheduler', () => {
  test('retries network errors and 429 with growing backoff, then succeeds', async () => {
    const waits: number[] = [];
    const run = createScheduler({
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5,
      perSecond: 1e9,
      baseDelayMs: 1000,
    });
    let calls = 0;
    const v = await run(async () => {
      calls++;
      if (calls === 1) throw new TypeError('Load failed');
      if (calls === 2) throw new HttpError(429, 'https://api.whatsonchain.com/x');
      return 'ok';
    });
    expect(v).toBe('ok');
    expect(calls).toBe(3);
    expect(waits.filter((w) => w >= 1000)).toEqual([1000, 2000]);
  });

  test('gives up after `tries` and never retries a plain 4xx', async () => {
    const run = createScheduler({ sleep: noSleep, tries: 3, perSecond: 1e9 });
    let calls = 0;
    await expect(
      run(async () => {
        calls++;
        throw new TypeError('Load failed');
      }),
    ).rejects.toThrow('Load failed');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      run(async () => {
        calls++;
        throw new HttpError(404, 'https://api.whatsonchain.com/x');
      }),
    ).rejects.toThrow('404');
    expect(calls).toBe(1);
    expect(isTransient(new HttpError(503, 'https://a.b/'))).toBe(true);
  });

  test('never runs more than `concurrency` jobs at once', async () => {
    const run = createScheduler({ concurrency: 2, perSecond: 1e9, sleep: noSleep });
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        run(async () => {
          peak = Math.max(peak, ++live);
          await new Promise((r) => setTimeout(r, 2));
          live--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test('spaces starts to the rate', async () => {
    const t = 0;
    const waits: number[] = [];
    const run = createScheduler({
      concurrency: 10,
      perSecond: 4,
      now: () => t,
      sleep: async (ms) => void waits.push(ms),
    });
    await Promise.all(Array.from({ length: 4 }, () => run(async () => null)));
    expect(waits).toEqual([250, 500, 750]);
  });
});

describe('tx cache', () => {
  test('memory + storage, survives a new reader, skips big txs, evicts past the cap', () => {
    const store = memStore();
    const c = createTxCache(store, 30);
    c.set('a'.repeat(64), 'aaaaaaaaaa');
    c.set('b'.repeat(64), 'bbbbbbbbbb');
    expect(createTxCache(store).get('a'.repeat(64))).toBe('aaaaaaaaaa');
    c.set('c'.repeat(64), 'cccccccccccccccc');
    expect(store.getItem(`bw.relayx.tx.${'a'.repeat(64)}`)).toBeNull();
    c.set('d'.repeat(64), 'x'.repeat(200_001));
    expect(store.getItem(`bw.relayx.tx.${'d'.repeat(64)}`)).toBeNull();
    expect(c.get('d'.repeat(64))?.length).toBe(200_001);
  });
});

describe('chain reader', () => {
  test('batches getTx calls into one WoC /txs/hex request and caches them', async () => {
    const txs = Array.from({ length: 25 }, (_, i) => tx(i));
    const hex = new Map(txs.map((t) => [t.id('hex'), t.toHex()]));
    const bodies: string[][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toContain('/txs/hex');
      const ids = JSON.parse(String(init?.body)).txids as string[];
      bodies.push(ids);
      return new Response(JSON.stringify(ids.map((t) => ({ txid: t, hex: hex.get(t) }))));
    }) as unknown as typeof fetch;
    const r = createChainReader({ fetch: f, sleep: noSleep, perSecond: 1e9, batchMs: 0 });
    const got = await Promise.all(txs.map((t) => r.getTx(t.id('hex'))));
    expect(got.map((t) => t.id('hex'))).toEqual(txs.map((t) => t.id('hex')));
    expect(bodies.map((b) => b.length)).toEqual([20, 5]);
    await r.getTx(txs[0].id('hex'));
    expect(bodies.length).toBe(2);
  });

  test('falls back to 1sat BEEF when WoC keeps refusing', async () => {
    const t = tx(7);
    const id = t.id('hex');
    const f = (async (url: string) => {
      if (url.includes('whatsonchain')) return new Response('', { status: 429 });
      expect(url).toBe(`https://api.1sat.app/1sat/beef/${id}`);
      return new Response(new Uint8Array(t.toAtomicBEEF(true)));
    }) as unknown as typeof fetch;
    const r = createChainReader({ fetch: f, sleep: noSleep, perSecond: 1e9, batchMs: 0, tries: 2 });
    expect((await r.getTx(id)).id('hex')).toBe(id);
  });

  test('pages unspent/all and reads holdings in bulk', async () => {
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/addresses/unspent')) {
        const a = JSON.parse(String(init?.body)).addresses as string[];
        return new Response(JSON.stringify(a.map((x, i) => ({ address: x, unspent: i === 1 ? [{}] : [] }))));
      }
      const second = url.includes('token=');
      return new Response(
        JSON.stringify({
          result: [{ tx_hash: second ? 'b'.repeat(64) : 'a'.repeat(64), tx_pos: 1, value: 273 }],
          nextPageToken: second ? undefined : 'p2',
        }),
      );
    }) as unknown as typeof fetch;
    const r = createChainReader({ fetch: f, sleep: noSleep, perSecond: 1e9 });
    expect([...(await r.holding(['x', 'y'])).entries()]).toEqual([
      ['x', 0],
      ['y', 1],
    ]);
    expect((await r.unspent('1Addr')).map((u) => u.txid[0])).toEqual(['a', 'b']);
  });
});
