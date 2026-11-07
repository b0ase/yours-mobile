/**
 * F-B (release click-through, 4 Nov 2026): Recover change reads each seed address's history straight from
 * WhatsOnChain. An unused address's 404 is "no history" (it read as "the network was busy" through the toolbox), and
 * every page of a long history is read (WhatsOnChain returns 100 confirmed entries a page with nextPageToken).
 */
import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey } from '@bsv/sdk';
import { wocAddressHistory, wocScriptHash } from './seedChange';

const address = PrivateKey.fromRandom().toAddress();
const hash = wocScriptHash(new P2PKH().lock(address).toHex());
const txid = (n: number) => n.toString(16).padStart(64, '0');
type Reply = { status: number; body?: unknown };
const res = (r: Reply) =>
  ({ status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body ?? {} }) as unknown as Response;
const page = (from: number, n: number, next = '') => ({
  status: 200,
  body: {
    script: hash,
    result: Array.from({ length: n }, (_, i) => ({ tx_hash: txid(from + i), height: 900_000 })),
    nextPageToken: next,
    error: '',
  },
});

/** A fake WhatsOnChain: `confirmed` and `unconfirmed` answer in turn per call; every URL is recorded. */
function woc(confirmed: Reply[], unconfirmed: Reply[] = [{ status: 200, body: { result: [], error: '' } }]) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const q = url.includes('/unconfirmed/history') ? unconfirmed : confirmed;
    return res(q.length > 1 ? q.shift()! : q[0]);
  };
  const history = wocAddressHistory({ fetch: fetch as never, minIntervalMs: 0, sleep: async () => undefined });
  return { urls, history };
}

describe('wocAddressHistory', () => {
  test('WhatsOnChain script hash: sha256 of the script, byte-reversed (the route the real API answers)', () => {
    // bCorp's public pay address, read live 4 Nov 2026 at this hash.
    expect(wocScriptHash(new P2PKH().lock('192nuX6cz81MH3T2gwsam3FxYoDrvzDYpU').toHex())).toBe(
      'fe9908251451c8c2b065482d6ad99f370158c08b4776655484ec12fd70be781c',
    );
  });

  test('an unused address: 404 on the history call = no history (an empty list, not "busy")', async () => {
    const { urls, history } = woc([{ status: 404 }]);
    expect(await history(address)).toEqual([]);
    expect(urls[0]).toBe(`https://api.whatsonchain.com/v1/bsv/main/script/${hash}/confirmed/history`);
  });

  test('exactly 100 entries plus more: every page is read, following nextPageToken', async () => {
    const { urls, history } = woc([page(0, 100, 'tok/1+='), page(100, 12)]);
    const all = await history(address);
    expect(all?.length).toBe(112);
    expect(all?.[111]).toBe(txid(111));
    const confirmed = urls.filter((u) => u.includes('/confirmed/'));
    expect(confirmed).toHaveLength(2);
    expect(confirmed[1]).toBe(`${confirmed[0]}?token=${encodeURIComponent('tok/1+=')}`);
  });

  test('exactly 100 entries and no nextPageToken: one page, nothing more asked', async () => {
    const { urls, history } = woc([page(0, 100)]);
    expect((await history(address))?.length).toBe(100);
    expect(urls.filter((u) => u.includes('/confirmed/'))).toHaveLength(1);
  });

  test('a 404 on a LATER page is unclear, not the end of the history', async () => {
    const { history } = woc([page(0, 100, 'x'), { status: 404 }]);
    expect(await history(address)).toBeUndefined();
  });

  test('unconfirmed history is added (a payment still in the mempool), without duplicates', async () => {
    const { history } = woc([page(0, 2)], [page(1, 2)]);
    expect(await history(address)).toEqual([txid(0), txid(1), txid(2)]);
  });

  test('429 and 5xx are retried; still failing is unclear (undefined), never "no history"', async () => {
    expect(await woc([{ status: 429 }, page(0, 3)]).history(address)).toHaveLength(3);
    expect(await woc([{ status: 503 }]).history(address)).toBeUndefined();
    expect(await woc([page(0, 1)], [{ status: 502 }]).history(address)).toBeUndefined();
  });

  test('an error field or a body that is not a history page is unclear', async () => {
    expect(await woc([{ status: 200, body: { result: [], error: 'rate limited' } }]).history(address)).toBeUndefined();
    expect(await woc([{ status: 200, body: { nope: true } }]).history(address)).toBeUndefined();
    expect(await woc([{ status: 400 }]).history(address)).toBeUndefined();
  });

  test('a history longer than maxPages is unclear, never a silently cut list', async () => {
    const urls: string[] = [];
    const history = wocAddressHistory({
      fetch: (async (url: string) => (urls.push(url), res(page(urls.length * 100, 100, `t${urls.length}`)))) as never,
      minIntervalMs: 0,
      sleep: async () => undefined,
      maxPages: 3,
    });
    expect(await history(address)).toBeUndefined();
    expect(urls).toHaveLength(3);
  });

  test('a network error is retried, then unclear; a bad address is skipped without a call', async () => {
    let calls = 0;
    const flaky = wocAddressHistory({
      fetch: (async () => {
        calls++;
        throw new Error('offline');
      }) as never,
      minIntervalMs: 0,
      sleep: async () => undefined,
      attempts: 3,
    });
    expect(await flaky(address)).toBeUndefined();
    expect(calls).toBe(3);
    const { urls, history } = woc([page(0, 1)]);
    expect(await history('not-an-address')).toEqual([]);
    expect(urls).toHaveLength(0);
  });
});
