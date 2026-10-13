import { describe, expect, test } from 'bun:test';
import type { Fetch } from './names';
import { LIVE_CACHE_KEY, liveDomains, OTHER_PAYMAIL_DOMAINS, withDomain } from './paymailDomains';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

const fetchWith =
  (alive: Record<string, 'ok' | 'nocaps' | 'hang' | number>, calls: string[] = []): Fetch =>
  async (url, init) => {
    calls.push(url);
    const d = new URL(url).hostname;
    const a = alive[d];
    if (a === 'ok') return new Response(JSON.stringify({ capabilities: { pki: 'x' } }), { status: 200 });
    if (a === 'nocaps') return new Response('{}', { status: 200 });
    if (a === 'hang')
      return new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    return new Response('{}', { status: typeof a === 'number' ? a : 404 });
  };

describe('Other wallet domain list', () => {
  test('only domains whose bsvalias answers are shown; dead/hanging ones hidden', async () => {
    const f = fetchWith({ 'handcash.io': 'ok', 'twetch.me': 'nocaps', 'relayx.io': 500, 'simply.cash': 'hang' });
    const live = await liveDomains(f, { store: memStore(), now: 1, timeoutMs: 30 });
    expect(live).toEqual(['handcash.io']);
  });
  test('cached about a day, then re-checked', async () => {
    const store = memStore();
    const calls: string[] = [];
    const f = fetchWith({ 'handcash.io': 'ok', 'centbee.com': 'ok' }, calls);
    expect(await liveDomains(f, { store, now: 1000 })).toEqual(
      ['centbee.com', 'handcash.io'].sort(
        (a, b) => OTHER_PAYMAIL_DOMAINS.indexOf(a as never) - OTHER_PAYMAIL_DOMAINS.indexOf(b as never),
      ),
    );
    const n = calls.length;
    await liveDomains(f, { store, now: 1000 + 60_000 });
    expect(calls.length).toBe(n);
    await liveDomains(f, { store, now: 1000 + 25 * 3600_000 });
    expect(calls.length).toBe(n * 2);
    expect(store.m.has(LIVE_CACHE_KEY)).toBe(true);
  });
  test('withDomain builds the full paymail', () => {
    expect(withDomain('$Boase', 'handcash.io')).toBe('boase@handcash.io');
    expect(withDomain('boase@twetch.me', 'handcash.io')).toBe('boase@handcash.io');
    expect(withDomain('  ', 'handcash.io')).toBe('');
  });
});
