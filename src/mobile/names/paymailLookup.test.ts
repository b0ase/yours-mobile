/**
 * Review, 15 Nov 2026: any failed lookup (429, 5xx) used to read as "no name", and the name sync then wiped a named
 * account's cached name. Only the server's definite answer may: the lookup handler's 404 {"error":"not-found"}.
 * The answers below marked "server" come from the real handler (site/lib/paymail.js).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import server from '../../../site/lib/paymail.js';
import { syncPaymailCache } from './accountName';
import { lookupPaymailStateAt, type PaymailLookup } from './paymail';

const KEY = '02' + 'ab'.repeat(32);
const ID = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const URL_ = `https://pay.test/api/paymail/lookup?key=${KEY}`;

/** A fetch answered by the real lookup handler over a store holding `rows`. */
const serverFetch = (rows: Record<string, { alias: string; kind?: string }>) => {
  const h = server.makeHandlers({
    store: { getAliasByKey: async (k: string) => rows[k] ?? null },
    env: { PAYMAIL_DOMAIN: 'bwalletx.com' },
  });
  return async (url: string) => {
    const [status, body] = await h.lookup(Object.fromEntries(new URL(url).searchParams));
    return new Response(JSON.stringify(body), { status });
  };
};
const answers = (status: number, body: string) => async () => new Response(body, { status });

describe('what a lookup answer means', () => {
  test('server: a registered key is a name', async () => {
    const r = await lookupPaymailStateAt(serverFetch({ [KEY]: { alias: 'peytonmoon69' } }), URL_);
    expect(r).toEqual({ state: 'name', paymail: 'peytonmoon69@bwalletx.com' });
  });

  test('server: an unregistered key is the definite no-name, 404 {"error":"not-found"}', async () => {
    const f = serverFetch({});
    const raw = await f(URL_);
    expect(raw.status).toBe(404);
    expect(await raw.json()).toEqual({ error: 'not-found' });
    expect(await lookupPaymailStateAt(f, URL_)).toEqual({ state: 'none' });
  });

  test('everything else is "couldn’t tell", never "no name"', async () => {
    const unknown: PaymailLookup = { state: 'unknown' };
    for (const f of [
      answers(429, '{"error":"rate-limited"}'), // site/api/paymail.js
      answers(500, '{"error":"server-error"}'),
      answers(503, '{"error":"paymail-not-configured"}'),
      answers(502, '<html>Bad Gateway</html>'),
      answers(404, '<html>Not Found</html>'), // a proxy's 404, not the handler's
      answers(404, '{"error":"something else"}'),
      answers(400, '{"error":"invalid-key"}'),
      answers(200, 'not json'),
      answers(200, '{"paymail":""}'),
      answers(200, '{}'),
      async () => {
        throw new TypeError('Failed to fetch');
      },
      async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
    ])
      expect(await lookupPaymailStateAt(f, URL_)).toEqual(unknown);
  });
});

describe('the name sync and the cached name', () => {
  const real = globalThis.localStorage;
  let m: Map<string, string>;
  beforeEach(() => {
    m = new Map();
    globalThis.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
  });
  afterEach(() => {
    globalThis.localStorage = real;
  });
  const CACHE = `bwallet.paymail.${ID}`;
  /** The sync's own step, with the real lookup reader pointed at a test URL. */
  const sync = (f: (u: string) => Promise<Response>) =>
    syncPaymailCache(f as never, ID, KEY, (ff) => lookupPaymailStateAt(ff, URL_));

  test('429 and 500 keep the cached name, and the sync reports it could not check', async () => {
    for (const f of [answers(429, '{"error":"rate-limited"}'), answers(500, '{"error":"server-error"}')]) {
      m.set(CACHE, 'peytonmoon69@bwalletx.com');
      await expect(sync(f)).rejects.toThrow(/Could not check/);
      expect(m.get(CACHE)).toBe('peytonmoon69@bwalletx.com');
    }
  });

  test('no network keeps the cached name', async () => {
    m.set(CACHE, 'peytonmoon69@bwalletx.com');
    await expect(
      sync(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).rejects.toThrow();
    expect(m.get(CACHE)).toBe('peytonmoon69@bwalletx.com');
  });

  test('server: the definite no-name clears it', async () => {
    m.set(CACHE, 'peytonmoon69@bwalletx.com');
    expect(await sync(serverFetch({}))).toBe('');
    expect(m.has(CACHE)).toBe(false);
  });

  test('server: a name is cached, and a changed name replaces the old one', async () => {
    expect(await sync(serverFetch({ [KEY]: { alias: 'peytonmoon69' } }))).toBe('peytonmoon69@bwalletx.com');
    expect(m.get(CACHE)).toBe('peytonmoon69@bwalletx.com');
    expect(await sync(serverFetch({ [KEY]: { alias: 'peyton' } }))).toBe('peyton@bwalletx.com');
    expect(m.get(CACHE)).toBe('peyton@bwalletx.com');
  });

  test('the sync uses this step, and nothing else writes "" over the cached name on a failed lookup', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./accountName.ts', import.meta.url), 'utf8');
    expect(src).toContain('const p = await syncPaymailCache(f, identityAddress, publicKey);');
    expect(src).not.toContain("setPaymail(identityAddress, p ?? '')");
    expect(src).not.toContain('lookupPaymail(');
  });
});
