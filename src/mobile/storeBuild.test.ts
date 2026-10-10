import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  BUY_CRYPTO_ENABLED,
  PAID_FEATURES_ENABLED,
  buyCryptoEnabled,
  STORE_BUILD,
  agentModeFor,
  bcorpFeeAddress,
  marketFiltersFor,
  marketTradingEnabled,
  marketLabel,
  isBWalletX,
  appNameFor,
  mintChoicesFor,
  ownerAppsFor,
  paidFeaturesEnabled,
  tokenRoomsEnabled,
  walletKindsFor,
} from './storeBuild';
import { parseAgentPrefs } from './agent/agentPrefs';

const KINDS = [
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['tickets', 'Tickets'],
  ['credits', 'Credits'],
] as const;
const FILTERS = [
  ['all', 'All tokens', true],
  ['bapps', 'bApps', true],
  ['tickets', 'Tickets', true],
] as const;

describe('storeBuild', () => {
  test('store build leaves out the TokenBlaster app tile', () => {
    const apps = [{ name: 'TokenBlaster' }, { name: 'bMusic' }];
    expect(ownerAppsFor(apps, true).map((a) => a.name)).toEqual(['bMusic']);
    expect(ownerAppsFor(apps, false)).toHaveLength(2);
  });
  test('default (test) build is not a store build', () => {
    expect(STORE_BUILD).toBe(false);
    // The live default leaves paid mode alone.
    expect(parseAgentPrefs({ mode: 'paid' }).mode).toBe('paid');
  });

  test('b agent: own key only in a store build', () => {
    expect(agentModeFor('paid', true)).toBe('own');
    expect(agentModeFor('own', true)).toBe('own');
    expect(agentModeFor('paid', false)).toBe('paid');
  });

  test('no bCorp fee address in a store build', () => {
    expect(bcorpFeeAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', true)).toBe('');
    expect(bcorpFeeAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', false)).toBe('1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
  });

  test('wallet kinds: no Tickets / Credits in a store build', () => {
    expect(walletKindsFor(KINDS, true).map((k) => k[0])).toEqual(['tokens', 'nfts']);
    expect(walletKindsFor(KINDS, false).map((k) => k[0])).toEqual(['tokens', 'nfts', 'tickets', 'credits']);
  });

  test('market filters: no bApps / Tickets in a store build', () => {
    expect(marketFiltersFor(FILTERS, true).map((f) => f[0])).toEqual(['all', 'bapps']);
    expect(marketFiltersFor(FILTERS, false)).toHaveLength(3);
  });

  test('trading, token rooms, paid features and mint choices', () => {
    expect(marketTradingEnabled(true)).toBe(false);
    expect(marketTradingEnabled(false)).toBe(true);
    expect(tokenRoomsEnabled(true)).toBe(false);
    expect(tokenRoomsEnabled(false)).toBe(true);
    expect(paidFeaturesEnabled(true)).toBe(false);
    expect(paidFeaturesEnabled(false)).toBe(true);
    expect(mintChoicesFor(true)).toEqual(['token', 'media']);
    expect(mintChoicesFor(false)).toEqual(['ticket', 'token', 'media']);
  });

  test('bWalletX branding outside the store build', () => {
    expect(isBWalletX(true)).toBe(false);
    expect(isBWalletX(false)).toBe(true);
    expect(appNameFor(true)).toBe('bWallet');
    expect(appNameFor(false)).toBe('bWalletX');
  });
  test('marketLabel: Exchange in bWalletX, Market in the store app', () => {
    expect(marketLabel(false)).toBe('Exchange');
    expect(marketLabel(true)).toBe('Market');
  });
});

describe('store build: no buying, no personal token, no bWalletX text', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('buying crypto (Buy BSV, Get BSV, Get MNEE) is bWalletX only', () => {
    expect(buyCryptoEnabled(true)).toBe(false);
    expect(buyCryptoEnabled(false)).toBe(true);
    // The JSX constants match the functions for this build.
    expect(BUY_CRYPTO_ENABLED).toBe(buyCryptoEnabled());
    expect(PAID_FEATURES_ENABLED).toBe(paidFeaturesEnabled());
    const wallet = src('../pages/BsvWallet.tsx');
    expect(wallet).toMatch(/BUY_CRYPTO_ENABLED && \(\s*<BsvPriceBar/);
    expect(wallet).toMatch(/BUY_CRYPTO_ENABLED && \(\s*<BuyBsvButton/);
    expect(wallet).toContain('bsvBalance === 0 && BUY_CRYPTO_ENABLED');
    expect(wallet).toContain('BUY_CRYPTO_ENABLED && getBsvOpen &&');
    expect(wallet).toMatch(/BUY_CRYPTO_ENABLED && <Show when=\{!isProcessing && pageState === 'getMNEE'\}>/);
    expect(wallet).toContain('onGetMneeClick={BUY_CRYPTO_ENABLED ?');
  });

  test('Choose your handle: the token + room panel needs paid features', () => {
    expect(src('./names/HandleFlow.tsx')).toMatch(/PAID_FEATURES_ENABLED \? \(\s*<div[\s\S]*?Your token \+ room/);
  });

  test('store-reachable screens take the app name from APP_NAME, not a literal bWalletX', () => {
    for (const f of [
      './names/PasswordFields.tsx',
      './onboardingError.ts',
      './settings/ChangePassword.tsx',
      './backup/BackupStep.tsx',
      './bappFrame/BappFrameHost.tsx',
      './tokens/TokenIconHeader.tsx',
      './tabs/ChatPage.tsx',
      './wallet/BuyBsv.tsx',
      './strategies/strategyNft.ts',
      './contracts/contractNft.ts',
    ]) {
      const code = src(f)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
        .join('\n');
      expect([f, /bWalletX/.test(code)]).toEqual([f, false]);
    }
  });
});

describe('TOKENBLASTER_ENABLED: tokenblaster.lol data and the 1Sat Ordnance 3D catalogue are bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { TOKENBLASTER_ENABLED } = await import('./storeBuild');
    expect(TOKENBLASTER_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'TOKENBLASTER_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the TokenBlaster tile and Home addition are data only behind the flag', () => {
    expect(src('./ownerApps.ts')).toContain('...(TOKENBLASTER_ENABLED ? TOKENBLASTER_APPS : [])');
    expect(src('./ownerAppsX.store.ts')).not.toContain('TokenBlaster');
    expect(src('../../vite.config.mobile.ts')).toContain("'src/mobile/ownerAppsX.store.ts'");
    const b = src('./BrowserPage.tsx');
    expect(b).toContain("...(TOKENBLASTER_ENABLED ? ['TokenBlaster'] : [])");
    expect(b).toMatch(/HOME_ADDITIONS[^=]*= TOKENBLASTER_ENABLED\s*\?/);
  });
  test('no static import of the Ordnance catalogue outside three3d/', () => {
    for (const f of ['./market/MarketPage.tsx', './media/MediaSection.tsx']) {
      const s = src(f);
      expect(s).not.toMatch(/^import (?!type )[^;]*from '\.\.\/three3d\/(ordnance|OrdnanceGrid|Cabinet)';/m);
      expect(s).toContain('TOKENBLASTER_ENABLED');
    }
    expect(src('./market/MarketPage.tsx')).toContain('...(TRADING && TOKENBLASTER_ENABLED');
  });
});

describe('pots and subscriptions: pots + person standing orders everywhere, services and billing bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('pots and standing orders are on in both builds', async () => {
    const { potsEnabled, standingOrdersEnabled } = await import('./storeBuild');
    expect(potsEnabled(true)).toBe(true);
    expect(potsEnabled(false)).toBe(true);
    expect(standingOrdersEnabled(true)).toBe(true);
    expect(standingOrdersEnabled(false)).toBe(true);
  });
  test('service subscriptions and billing are off in a store build', async () => {
    const { subscriptionsEnabled, billingAllowed } = await import('./storeBuild');
    expect(subscriptionsEnabled(true)).toBe(false);
    expect(subscriptionsEnabled(false)).toBe(true);
    expect(billingAllowed(true)).toBe(false);
    expect(billingAllowed(false)).toBe(true);
  });
  test('SUBSCRIPTIONS_ENABLED / BILLING_ENABLED are the inverse of STORE_BUILD, from the same literal env', async () => {
    const { SUBSCRIPTIONS_ENABLED, BILLING_ENABLED } = await import('./storeBuild');
    expect(SUBSCRIPTIONS_ENABLED).toBe(!STORE_BUILD);
    expect(BILLING_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'SUBSCRIPTIONS_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
    expect(cond(s, 'BILLING_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('own-service payees are data only behind SUBSCRIPTIONS_ENABLED', () => {
    expect(src('./pots/pots.ts')).toMatch(/OWN_SERVICE_PAYEES[^=]*= SUBSCRIPTIONS_ENABLED\s*\?/);
  });
});

/** The store-edition wording, read from a fresh process with the store env (STORE_BUILD is fixed at import). */
describe('store edition text', () => {
  const read = (env: Record<string, string>) => {
    const code =
      "const m = await import('./src/mobile/storeBuild.ts'); console.log(JSON.stringify({ banner: m.handleCardText(false), named: m.handleCardText(true), tokens: m.MY_TOKENS_DESC, note: m.MY_TOKENS_NOTE, agent: m.B_AGENT_DESC, subs: m.SUBSCRIPTIONS_DESC, pots: m.POTS_INTRO, pot: m.POT_NAME_PLACEHOLDER, name: m.APP_NAME }));";
    const r = Bun.spawnSync(['bun', '-e', code], {
      env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
    });
    return JSON.parse(r.stdout.toString()) as Record<string, string>;
  };
  test('store build: no chat rooms, token rooms, paid b agent or app subscriptions', () => {
    const t = read({ VITE_STORE_BUILD: '1' });
    expect(t.name).toBe('bWallet');
    expect(t.banner).toBe('A free handle people can pay.');
    expect(t.named).toBe('A free handle people can pay.');
    expect(t.agent).toBe('Use your own AI key');
    expect(t.tokens).not.toMatch(/room/i);
    expect(t.note).not.toMatch(/room/i);
    expect(t.subs).toBe('Regular payments to people, from pots you fill');
    expect(t.pots).not.toMatch(/subscri/i);
    expect(t.pot).not.toMatch(/bChat/);
    expect(Object.values(t).join(' ')).not.toMatch(/chat room|bWalletX|paid for|\$1|Buy BSV|trad/i);
  });
  test('ios-store channel gets the same text', () => {
    expect(read({ VITE_CHANNEL: 'ios-store' }).agent).toBe('Use your own AI key');
  });
  test('bWalletX wording is unchanged', () => {
    const t = read({});
    expect(t.name).toBe('bWalletX');
    expect(t.banner).toBe('A free handle people can pay, plus your own chat room.');
    expect(t.agent).toBe('How the b agent is paid for');
    expect(t.tokens).toContain('their rooms');
  });
});

/** No Market / Exchange in a store build (App Review 3.1.5(iii), 7 Oct 2026). */
describe('store build has no Market', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const storeEval = (expr: string, env: Record<string, string> = { VITE_STORE_BUILD: '1' }) => {
    const r = Bun.spawnSync(
      [
        'bun',
        '-e',
        `const s = await import('./src/mobile/storeBuild.ts'); const t = await import('./src/mobile/tabs/tabs.ts'); console.log(JSON.stringify(${expr}));`,
      ],
      {
        env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
      },
    );
    return JSON.parse(r.stdout.toString());
  };
  test('MARKET_ENABLED is the inverse of STORE_BUILD, from the same literal env', async () => {
    const { MARKET_ENABLED } = await import('./storeBuild');
    expect(MARKET_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'MARKET_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('Swap: SWAP_ENABLED mirrors MARKET_ENABLED; the top row is always the price card; Swap is only the promo card (dropped in the store edition)', async () => {
    const { SWAP_ENABLED } = await import('./storeBuild');
    expect(SWAP_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'SWAP_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
    expect(storeEval('s.SWAP_ENABLED')).toBe(false);
    expect(storeEval('s.SWAP_ENABLED', { VITE_CHANNEL: 'android-play' })).toBe(false);
    expect(storeEval('s.SWAP_ENABLED', {})).toBe(true);
    const bar = src('./wallet/BuyBsv.tsx');
    expect(bar).toMatch(/const SwapFlow = SWAP_ENABLED \? lazy\(/);
    expect(bar).not.toMatch(/SwapCell/);
    expect(bar).toMatch(/<PriceCell rate=\{rate\} onOpen=\{onPrice\} change=\{change\} \/>/);
    expect(bar).toMatch(/swapOn && SwapPromo && \(/);
    const w = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
    expect(w).toMatch(/\{!BUY_CRYPTO_ENABLED && <BsvHistoryBar/);
  });
  test('store tabs: no Market tab, and market ids land on Wallet', () => {
    const t = storeEval(
      '{ order: t.TAB_ORDER, tab: t.tabFor("market"), route: t.routeFor("market"), m: s.MARKET_ENABLED }',
    );
    expect(t.m).toBe(false);
    expect(t.order).toEqual(['bsv', 'browser', 'feed', 'chat']);
    expect(t.tab).toBe('bsv');
    expect(t.route).toBe('/bsv-wallet');
    expect(storeEval('t.TAB_ORDER', { VITE_CHANNEL: 'ios-store' })).not.toContain('market');
  });
  test('bWalletX keeps the Exchange tab', () => {
    const t = storeEval('{ order: t.TAB_ORDER, route: t.routeFor("market") }', {});
    expect(t.order).toContain('market');
    expect(t.route).toBe('/m/market');
  });
  test('the Market route and its chunk are behind MARKET_ENABLED', () => {
    const r = src('./tabs/MobileRoutes.tsx');
    expect(r).toMatch(/const MarketPage = MARKET_ENABLED \? lazy\(/);
    expect(r).toMatch(/\{MarketPage && <Route path="market"/);
  });
  test('Buy / Get PNEEs / Back PNEEs entry points are behind MARKET_ENABLED', () => {
    expect(src('./chat/OpenTokenRoomButton.tsx')).toMatch(/if \(!id \|\| !MARKET_ENABLED\) return null/);
    expect(src('./wallet/FriendToken.tsx')).toMatch(/!MARKET_ENABLED \? null/);
    const cards = src('./wallet/DefaultTokenCards.tsx');
    expect(cards).toMatch(/PNEE_TOKEN_ID && MARKET_ENABLED/);
    expect(cards).toMatch(/MARKET_ENABLED\s*\?\s*\{ label: BACK_PNEE_LABEL/);
    expect(src('./locks/LockScreen.tsx')).toMatch(/MARKET_ENABLED && backPnee && <BackPneeAmountSheet/);
    expect(src('./radarApps.ts')).toMatch(/const BUY_APPS[^=]*= MARKET_ENABLED\s*\?/);
  });
  test('Apps tab: no exchange / swap tiles or market / on-ramp groups in a store build', async () => {
    const { appsTileShown, radarGroupShown } = await import('./storeBuild');
    expect(appsTileShown('bExchange', true)).toBe(false);
    expect(appsTileShown('bChat', true)).toBe(true);
    expect(appsTileShown('bExchange', false)).toBe(true);
    expect(radarGroupShown('market', true)).toBe(false);
    expect(radarGroupShown('buy', true)).toBe(false);
    expect(radarGroupShown('social', true)).toBe(true);
    expect(radarGroupShown('market', false)).toBe(true);
  });
  const appsEval = (expr: string, env: Record<string, string> = { VITE_STORE_BUILD: '1' }) => {
    const r = Bun.spawnSync(
      [
        'bun',
        '-e',
        `const b = await import('./src/mobile/bapps.ts'); const r = await import('./src/mobile/radarApps.ts'); console.log(JSON.stringify(${expr}));`,
      ],
      { env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env } },
    );
    return JSON.parse(r.stdout.toString());
  };
  const APPS_EXPR =
    '{ bapps: b.BAPPS.map((a) => a.name), groups: r.RADAR_GROUPS.map((g) => g.id), radar: r.RADAR_APPS.filter((a) => a.group === "market" || a.group === "buy").length }';
  test('store build: bExchange, the market group and its apps are not in the data at all', () => {
    for (const env of [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }]) {
      const a = appsEval(APPS_EXPR, env);
      expect(a.bapps).not.toContain('bExchange');
      expect(a.bapps).toContain('bMaps');
      expect(a.groups).not.toContain('market');
      expect(a.groups).toContain('social');
      expect(a.radar).toBe(0);
    }
  });
  test('bWalletX keeps bExchange and Markets & collectibles', () => {
    const a = appsEval(APPS_EXPR, {});
    expect(a.bapps).toContain('bExchange');
    expect(a.groups).toContain('market');
    expect(a.radar).toBeGreaterThan(10);
  });
  test('the exchange data lives in exchangeAppsX.ts: MARKET_ENABLED-gated, swapped for an empty file in store builds', () => {
    const x = src('./exchangeAppsX.ts');
    expect(x).toMatch(/EXCHANGE_BAPPS[^=]*= MARKET_ENABLED\s*\?/);
    expect(x).toMatch(/MARKET_APPS[^=]*= MARKET_ENABLED\s*\?/);
    expect(x).toContain("'./brand/apps/bexchange.png'");
    const st = src('./exchangeAppsX.store.ts');
    expect(st).not.toMatch(/bExchange|bexchange|Markets|\.png/);
    expect(st).toContain('EXCHANGE_BAPPS: BApp[] = []');
    expect(st).toContain("MARKET_APPS: Omit<RadarApp, 'source'>[] = []");
    const v = readFileSync(new URL('../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(v).toMatch(
      /MOBILE_SWAPS\[resolve\(__dirname, 'src\/mobile\/exchangeAppsX\.ts'\)\] = resolve\(\s*__dirname,\s*'src\/mobile\/exchangeAppsX\.store\.ts'/,
    );
    // Nothing else imports the bExchange icon or holds a 'market' tile.
    expect(src('./bapps.ts')).not.toMatch(/bexchange|name: 'bExchange'/);
    const r = src('./radarApps.ts');
    expect(r).not.toContain("group: 'market'");
    expect(r).toMatch(
      /\.\.\.\(MARKET_ENABLED \? \[\{ id: 'market' as const, label: 'Markets & collectibles' \}\] : \[\]\)/,
    );
  });
  test('the inherited Ordinals › List ("Global orderbook") view is behind MARKET_ENABLED', () => {
    const v = readFileSync(new URL('../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(v).toContain("['  const listView = (', '  const listView = MARKET_ENABLED && (']");
  });
});

describe('phone layout store gates', () => {
  test('Exchange screen: shown in a direct build, hidden in a store build', async () => {
    const { screenShown, screensFor, dockItemsFor, peopleSellingEnabled } = await import('./storeBuild');
    expect(screenShown('exchange', false)).toBe(true);
    expect(screenShown('exchange', true)).toBe(false);
    expect(screenShown('wallet', true)).toBe(true);
    const s = [{ id: 'wallet' }, { id: 'exchange' }, { id: 'feed' }];
    expect(screensFor(s, true).map((x) => x.id)).toEqual(['wallet', 'feed']);
    expect(screensFor(s, false)).toHaveLength(3);
    const items = [
      { kind: 'screen', id: 'exchange' },
      { kind: 'action', id: 'sendReceive' },
      { kind: 'screen', id: 'chat' },
    ];
    expect(dockItemsFor(items, true)).toEqual([
      { kind: 'action', id: 'sendReceive' },
      { kind: 'screen', id: 'chat' },
    ]);
    expect(dockItemsFor(items, false)).toHaveLength(3);
    expect(peopleSellingEnabled(true)).toBe(false);
    expect(peopleSellingEnabled(false)).toBe(true);
  });

  test('the phone layout is on unless classic is chosen; explicit choices are kept', async () => {
    const { phoneLayoutOn, setPhoneLayout, PHONE_LAYOUT_KEY } = await import('./phone/flag');
    const g = globalThis as Record<string, unknown>;
    const had = { localStorage: g.localStorage, window: g.window };
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    g.window ??= { dispatchEvent: () => true };
    try {
      expect(phoneLayoutOn()).toBe(true);
      store.set(PHONE_LAYOUT_KEY, '1');
      expect(phoneLayoutOn()).toBe(true);
      store.set(PHONE_LAYOUT_KEY, '0');
      expect(phoneLayoutOn()).toBe(false);
      setPhoneLayout(true);
      expect(store.get(PHONE_LAYOUT_KEY)).toBe('1');
      setPhoneLayout(false);
      expect(store.get(PHONE_LAYOUT_KEY)).toBe('0');
    } finally {
      g.localStorage = had.localStorage;
      g.window = had.window;
    }
  });
});

describe('BSPACES_ENABLED: bSpaces is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { BSPACES_ENABLED } = await import('./storeBuild');
    expect(BSPACES_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'BSPACES_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the tile, the route and the in-room banner sit behind the flag', () => {
    expect(src('./BrowserPage.tsx')).toContain('BSPACES_ENABLED ? [AGENT_TILE, BSPACES_TILE] : [AGENT_TILE]');
    expect(src('./tabs/MobileRoutes.tsx')).toContain(
      "BSPACES_ENABLED ? lazy(() => import('../spaces/SpacesPage')) : null",
    );
    expect(src('./tabs/ChatPage.tsx')).toMatch(/BSPACES_ENABLED && \(\s*<LiveBanner/);
    // The Chat tab's Spaces filter: chips and list both behind the flag.
    expect(src('./tabs/ChatPage.tsx').match(/BSPACES_ENABLED && ROOMS && handle && rooms/g)?.length).toBe(2);
  });
});

describe('PAID_CALLS_ENABLED: bPhone paid calls are bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { PAID_CALLS_ENABLED, paidCallsEnabled } = await import('./storeBuild');
    expect(PAID_CALLS_ENABLED).toBe(!STORE_BUILD);
    expect(paidCallsEnabled(true)).toBe(false);
    expect(paidCallsEnabled(false)).toBe(true);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'PAID_CALLS_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the bPhone tabs, the quote and the pay loop sit behind the flag', () => {
    expect(src('./calls/CallsList.tsx')).toContain(
      "PAID_CALLS_ENABLED ? lazy(() => import('./BPhoneSettings')) : null",
    );
    expect(src('./calls/CallsList.tsx')).toContain("PAID_CALLS_ENABLED ? lazy(() => import('./Directory')) : null");
    expect(src('./calls/CallsList.tsx')).toContain('phoneTabsFor(PAID_CALLS_ENABLED)');
    // The yellow bPhone card, the directory fetch and Services in search are bWalletX only.
    expect(src('./calls/CallsList.tsx')).toContain('{PAID_CALLS_ENABLED && <BPhoneCard');
    expect(src('./calls/CallsList.tsx')).toContain('if (!PAID_CALLS_ENABLED) return;');
    expect(src('./calls/CallsList.tsx')).toContain('services: PAID_CALLS_ENABLED ? (services ?? []) : []');
    expect(src('./calls/store.ts')).toContain('if (PAID_CALLS_ENABLED) {');
    expect(src('./calls/store.ts')).toMatch(/PAID_CALLS_ENABLED\) await meterTick/);
    expect(src('./calls/CallScreen.tsx')).toContain("PAID_CALLS_ENABLED && call.phase === 'quote' && <QuoteSheet");
  });
});
