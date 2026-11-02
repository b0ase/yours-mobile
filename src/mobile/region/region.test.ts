import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  GEO_URL,
  REGION_CACHE_KEY,
  REGION_CACHE_MS,
  REGION_GATE_ON,
  UK_COUNTRIES,
  __setRegionStatusForTests,
  buyCryptoAllowed,
  gateView,
  getRegionStatus,
  isRestrictedStatus,
  isUkCountry,
  isUkRestricted,
  lookupCountry,
  marketAllowed,
  readRegionCache,
  resolveRegion,
  retryRegionCheck,
  startRegionCheck,
  statusForCountry,
  swapAllowed,
  writeRegionCache,
} from './region';
import { TAB_ORDER, routeFor, tabFor, visibleTabs } from '../tabs/tabs';
import { feedsFor } from '../feed/feeds';
import { ukRestrictedGuide, BWALLET_GUIDE } from '../agent/guide';

/** In-memory Storage stand-in; `broken` throws on every call (private mode, blocked site data). */
const memStore = (broken = false) => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => {
      if (broken) throw new Error('blocked');
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked');
      m.set(k, v);
    },
  };
};

const jsonFetch = (body: unknown, ok = true) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    return { ok, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
};

const NOW = 1_800_000_000_000;

describe('UK region gate: country → status', () => {
  test('GB and the Crown dependencies are UK; case and spaces do not matter', () => {
    expect(UK_COUNTRIES).toEqual(['GB', 'GG', 'JE', 'IM']);
    for (const c of ['GB', 'gb', ' GB ', 'GG', 'JE', 'IM']) {
      expect(isUkCountry(c)).toBe(true);
      expect(statusForCountry(c)).toBe('uk');
    }
  });
  test('other countries are allowed; IE and FR are not UK', () => {
    for (const c of ['US', 'IE', 'FR', 'DE', 'JP']) expect(statusForCountry(c)).toBe('allowed');
  });
  test('no country or a bad code is unknown (restricted)', () => {
    for (const c of [null, undefined, '', 'G', 'GBR', '12', 'XX1']) expect(statusForCountry(c)).toBe('unknown');
  });
  test('only a positive "not UK" answer unlocks (fail closed)', () => {
    expect(isRestrictedStatus('allowed')).toBe(false);
    for (const s of ['checking', 'uk', 'unknown'] as const) expect(isRestrictedStatus(s)).toBe(true);
  });
});

describe('UK region gate: lookup', () => {
  test('GB → restricted, cached for 24 hours', async () => {
    const st = memStore();
    const { f, calls } = jsonFetch({ country: 'GB' });
    expect(await resolveRegion({ fetchImpl: f, storage: st, now: NOW })).toEqual({ status: 'uk', country: 'GB' });
    expect(calls).toEqual([GEO_URL]);
    expect(JSON.parse(st.m.get(REGION_CACHE_KEY)!)).toEqual({ country: 'GB', at: NOW });
  });
  test('US → allowed', async () => {
    const { f } = jsonFetch({ country: 'US' });
    expect(await resolveRegion({ fetchImpl: f, storage: memStore(), now: NOW })).toEqual({
      status: 'allowed',
      country: 'US',
    });
  });
  test('fetch error → restricted (unknown), nothing cached', async () => {
    const st = memStore();
    const f = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await resolveRegion({ fetchImpl: f, storage: st, now: NOW })).toEqual({ status: 'unknown', country: null });
    expect(st.m.size).toBe(0);
  });
  test('HTTP error, a null country or a bad body → restricted (unknown)', async () => {
    for (const [body, ok] of [
      [{ country: 'US' }, false],
      [{ country: null }, true],
      [{}, true],
      [null, true],
      [{ country: 'USA' }, true],
    ] as const) {
      const st = memStore();
      const { f } = jsonFetch(body, ok);
      expect((await resolveRegion({ fetchImpl: f, storage: st, now: NOW })).status).toBe('unknown');
      expect(st.m.size).toBe(0);
    }
  });
  test('no answer within the timeout → restricted (unknown)', async () => {
    const hang = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await lookupCountry(hang, 30)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await resolveRegion({ fetchImpl: hang, storage: memStore(), now: NOW, timeoutMs: 30 })).status).toBe(
      'unknown',
    );
  });
  test('a fresh cached answer is used without asking again', async () => {
    const st = memStore();
    writeRegionCache('US', st, NOW);
    const { f, calls } = jsonFetch({ country: 'GB' });
    expect(await resolveRegion({ fetchImpl: f, storage: st, now: NOW + REGION_CACHE_MS - 1 })).toEqual({
      status: 'allowed',
      country: 'US',
    });
    expect(calls).toHaveLength(0);
  });
  test('cache expiry: after 24 hours the endpoint is asked again', async () => {
    const st = memStore();
    writeRegionCache('US', st, NOW);
    expect(readRegionCache(st, NOW + REGION_CACHE_MS)).toBeNull();
    const { f, calls } = jsonFetch({ country: 'GB' });
    expect((await resolveRegion({ fetchImpl: f, storage: st, now: NOW + REGION_CACHE_MS })).status).toBe('uk');
    expect(calls).toHaveLength(1);
  });
  test('a cache entry from the future or a junk entry is ignored', () => {
    const st = memStore();
    st.setItem(REGION_CACHE_KEY, JSON.stringify({ country: 'US', at: NOW + 60_000 }));
    expect(readRegionCache(st, NOW)).toBeNull();
    st.setItem(REGION_CACHE_KEY, '{not json');
    expect(readRegionCache(st, NOW)).toBeNull();
    st.setItem(REGION_CACHE_KEY, JSON.stringify({ country: 'nope', at: NOW }));
    expect(readRegionCache(st, NOW)).toBeNull();
  });
  test('Retry (force) skips the cache', async () => {
    const st = memStore();
    writeRegionCache('US', st, NOW);
    const { f, calls } = jsonFetch({ country: 'JE' });
    expect((await resolveRegion({ fetchImpl: f, storage: st, now: NOW, force: true })).status).toBe('uk');
    expect(calls).toHaveLength(1);
  });
  test('blocked storage: still answers, never throws', async () => {
    const { f } = jsonFetch({ country: 'US' });
    expect((await resolveRegion({ fetchImpl: f, storage: memStore(true), now: NOW })).status).toBe('allowed');
    expect(readRegionCache(memStore(true), NOW)).toBeNull();
    expect(() => writeRegionCache('US', memStore(true), NOW)).not.toThrow();
  });
  test('asks our own endpoint, never a third-party IP service', () => {
    expect(GEO_URL).toBe('https://web.bwalletx.com/api/geo');
    const src = readFileSync(new URL('./region.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ipapi|ipinfo|ip-api|geoip|ipify|cloudflare.*trace/i);
  });
});

describe('UK region gate: effective gates and routes', () => {
  test('this (bWalletX) test build has the gate on', () => expect(REGION_GATE_ON).toBe(true));
  test('market / swap / buy are open only after a "not UK" answer', () => {
    __setRegionStatusForTests('checking');
    expect([isUkRestricted(), marketAllowed(), swapAllowed(), buyCryptoAllowed()]).toEqual([true, false, false, false]);
    __setRegionStatusForTests('uk');
    expect([marketAllowed(), swapAllowed(), buyCryptoAllowed()]).toEqual([false, false, false]);
    __setRegionStatusForTests('unknown');
    expect([marketAllowed(), swapAllowed(), buyCryptoAllowed()]).toEqual([false, false, false]);
    __setRegionStatusForTests('allowed');
    expect([isUkRestricted(), marketAllowed(), swapAllowed(), buyCryptoAllowed()]).toEqual([false, true, true, true]);
    __setRegionStatusForTests('checking');
  });
  test('a guarded route shows the page only when allowed', () => {
    for (const kind of ['market', 'swap', 'buy'] as const) {
      expect(gateView(kind, 'allowed')).toBe('page');
      expect(gateView(kind, 'uk')).toBe('uk');
      expect(gateView(kind, 'unknown')).toBe('unknown');
      expect(gateView(kind, 'checking')).toBe('checking');
    }
  });
  test('tabs: no Exchange tab and market ids land on Wallet when restricted', () => {
    expect(visibleTabs(true)).toEqual(TAB_ORDER);
    expect(visibleTabs(false)).toEqual(TAB_ORDER.filter((t) => t !== 'market'));
    expect(visibleTabs(false)).not.toContain('market');
    expect(tabFor('market', false)).toBe('bsv');
    expect(routeFor('market', false)).toBe('/bsv-wallet');
    expect(tabFor('market', true)).toBe('market');
    expect(routeFor('market', true)).toBe('/m/exchange');
    // Defaults keep the build flag (storeBuild.test.ts relies on them).
    expect(routeFor('market')).toBe('/m/exchange');
  });
  test('Feed: no bExchange reel when restricted', () => {
    expect(feedsFor(true).some((f) => f.id === 'bexchange')).toBe(true);
    expect(feedsFor(false).some((f) => f.id === 'bexchange')).toBe(false);
  });
  test('Ask b: the restricted guide has no Exchange buying or coin launches', () => {
    const g = ukRestrictedGuide(BWALLET_GUIDE);
    expect(BWALLET_GUIDE).toContain('Launch a coin');
    expect(g).not.toContain('Launch a coin');
    expect(g).not.toContain('Market: buy NFTs');
    expect(g).toContain('no Exchange, Swap or Buy BSV');
  });
});

describe('UK region gate: app-wide lookup', () => {
  test('one automatic lookup per run; after a failure only Retry asks again', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    let answer: unknown = { country: 'US' };
    globalThis.fetch = (async () => {
      calls++;
      if (answer instanceof Error) throw answer;
      return { ok: true, json: async () => answer } as Response;
    }) as unknown as typeof fetch;
    try {
      __setRegionStatusForTests('checking');
      expect(await startRegionCheck()).toBe('allowed');
      expect(getRegionStatus()).toBe('allowed');
      expect(calls).toBe(1);
      answer = new Error('offline');
      expect(await retryRegionCheck()).toBe('unknown');
      expect(calls).toBe(2);
      expect(await startRegionCheck()).toBe('unknown');
      expect(calls).toBe(2);
      answer = { country: 'GB' };
      expect(await retryRegionCheck()).toBe('uk');
      expect(marketAllowed()).toBe(false);
    } finally {
      globalThis.fetch = real;
      __setRegionStatusForTests('checking');
    }
  });
});

describe('UK region gate: wiring', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('deep links to the Exchange, Name stock, OpNS store and phone Exchange go through RegionGate', () => {
    const routes = src('../tabs/MobileRoutes.tsx');
    expect(routes).toMatch(/const ExchangeRoute = \(\) =>\s*ExchangePage \? \(\s*<RegionGate kind="market">/);
    expect(routes).toMatch(/\{ExchangePage && <Route path="exchange\/\*" element=\{<ExchangeRoute \/>\} \/>\}/);
    expect(routes).toMatch(/path="names\/store"\s*element=\{\s*<RegionGate kind="market">/);
    expect(src('../bmint/BmintPage.tsx')).toMatch(/path="store"\s*element=\{\s*<RegionGate kind="market">/);
    expect(src('../phone/pager.tsx')).toMatch(/<RegionGate kind="market">\s*<MarketPage \/>/);
    expect(src('../names/store/GuestNames.tsx')).toMatch(/<RegionGate kind="market">/);
    expect(src('../feed/FeedPage.tsx')).toMatch(/<RegionGate kind="market">\s*<Suspense fallback=\{null\}>\s*<BexReel/);
  });
  test('Swap, Buy BSV and price charts gate themselves, whoever mounts them', () => {
    expect(src('../swap/SwapFlow.tsx')).toMatch(/const view = gateView\('swap', useRegionStatus\(\)\)/);
    const buy = src('../wallet/BuyBsv.tsx');
    expect(buy).toMatch(
      /const BuyBsvSheetImpl[\s\S]*?const buyOk = useBuyCryptoAllowed\(\);[\s\S]*?if \(!buyOk\) return null;/,
    );
    expect(buy).toMatch(/const swapOn = SWAP_ENABLED && swapOk &&/);
    expect(src('../wallet/PriceChart.tsx')).toMatch(/export const BsvPriceChart = \(\) => \(useChartsAllowed\(\) \?/);
  });
  test('the web banner hides Swap / Buy until the region check allows them', () => {
    const css = src('../../web/web.css');
    expect(css).toMatch(/html:not\(\[data-bw-swap\]\) \.bwallet-web-banner__link\[data-bw-banner='swap'\]/);
    expect(css).toMatch(/html:not\(\[data-bw-buy\]\) \.bwallet-web-banner__link\[data-bw-banner='buy'\]/);
    const banner = src('../../web/BannerActions.tsx');
    expect(banner).toContain("if (a === 'swap' && SWAP_ENABLED && swapAllowed())");
    expect(banner).toContain("if (a === 'buy' && BUY_CRYPTO_ENABLED && buyCryptoAllowed())");
  });
  test('the bottom bar and Desktop sidebar drop the Exchange for a restricted visitor', () => {
    expect(src('../tabs/BottomMenu.tsx')).toMatch(/const shown = visibleTabs\(market\);/);
    expect(src('../wide/WideShell.tsx')).toContain('hidden: !MARKET_ENABLED || !market }');
  });
});

describe('UK region gate: store builds', () => {
  const storeEval = (expr: string, env: Record<string, string>) => {
    const r = Bun.spawnSync(
      ['bun', '-e', `const g = await import('./src/mobile/region/region.ts'); console.log(JSON.stringify(${expr}));`],
      { env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env } },
    );
    return JSON.parse(r.stdout.toString());
  };
  test('store builds never ask (no URL) and every gate stays shut, as before', () => {
    for (const env of [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }]) {
      const r = storeEval(
        '{ on: g.REGION_GATE_ON, url: g.GEO_URL, m: g.marketAllowed(), s: g.swapAllowed(), b: g.buyCryptoAllowed() }',
        env,
      );
      expect(r).toEqual({ on: false, url: '', m: false, s: false, b: false });
    }
  });
});
