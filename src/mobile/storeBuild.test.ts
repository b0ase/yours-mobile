import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  BUY_CRYPTO_ENABLED,
  ENVELOPES_ENABLED,
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
  ['shares', 'Shares'],
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

  test('wallet kinds: no Tickets / Shares in a store build', () => {
    expect(walletKindsFor(KINDS, true).map((k) => k[0])).toEqual(['tokens', 'nfts']);
    expect(walletKindsFor(KINDS, false).map((k) => k[0])).toEqual(['tokens', 'nfts', 'tickets', 'shares']);
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
    // Store parity: both editions show the same top row; the bar itself swaps Buy BSV for Receive.
    expect(wallet).toMatch(/<BsvPriceBar/);
    expect(wallet).not.toMatch(/BsvHistoryBar/);
    expect(wallet).toMatch(/BUY_CRYPTO_ENABLED && \(\s*<BuyBsvButton/);
    expect(wallet).toContain('bsvBalance === 0 && BUY_CRYPTO_ENABLED');
    expect(wallet).toContain('BUY_CRYPTO_ENABLED && getBsvOpen &&');
    expect(wallet).toMatch(/BUY_CRYPTO_ENABLED && <Show when=\{!isProcessing && pageState === 'getMNEE'\}>/);
    expect(wallet).toContain('onGetMneeClick={BUY_CRYPTO_ENABLED ?');
  });

  test('envelopes (#87) and the game room balance card (#101) are bWalletX only', () => {
    expect(ENVELOPES_ENABLED).toBe(!STORE_BUILD);
    const bg = src('../background.ts');
    // A site asking for a spending authorization in a store build is refused, never approved.
    expect(bg).toMatch(/if \(!ENVELOPES_ENABLED\) return reply\(\{ success: false, error: 'Not supported' \}\);/);
    expect(bg).toContain(
      "if (!ENVELOPES_ENABLED) {\n        sendResponse({ type: message.action, success: false, error: 'Not supported' });",
    );
    expect(src('../initWallet.ts')).toMatch(/: ENVELOPES_ENABLED\s*\? guardEnvelopes\(/);
    expect(src('../pages/Settings.tsx')).toContain("ENVELOPES_ENABLED && page === 'envelopes'");
    expect(src('../prompt-tab.tsx')).toContain('ENVELOPES_ENABLED && screen.payload.envelope');
    expect(src('./tabs/ChatPage.tsx')).toContain('{!STORE_BUILD && <SiteRoomBalance');
  });

  // Owner, 26 Oct 2026: the launcher left Choose your handle (PersonalTokenLauncher, "Launch your tokens" card).
  test('the token + room launcher needs paid features, and is not in Choose your handle', () => {
    expect(src('./names/PersonalTokenLauncher.tsx')).toMatch(
      /PAID_FEATURES_ENABLED \? \(\s*<div[\s\S]*?Your token \+ room/,
    );
    expect(src('./names/HandleFlow.tsx')).not.toContain('Your token + room');
    expect(src('./names/HandleOnboarding.tsx')).toMatch(/hasName && PAID_FEATURES_ENABLED && !hasRoom/);
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
    expect(b).toContain("...(TOKENBLASTER_ENABLED ? ['TERRORNODE'] : [])");
    expect(b).toMatch(/HOME_ADDITIONS[^=]*= TOKENBLASTER_ENABLED\s*\?/);
    // The TERRORNODE hero: behind the flag, and swapped for an empty stand-in in a store build.
    expect(b.match(/TOKENBLASTER_ENABLED && <TerrornodeHero /g)?.length).toBe(2);
    expect(src('../../vite.config.mobile.ts')).toContain("'src/mobile/games/TerrornodeHeroX.store.tsx'");
    expect(src('./games/TerrornodeHeroX.store.tsx')).not.toMatch(/tokenblaster|webp/i);
    expect(src('./feed/feeds.ts')).toContain(
      "...(TOKENBLASTER_ENABLED ? ([['tokenblaster', 'TokenBlaster']] as Entry[]) : [])",
    );
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

describe('HOLDER_DROP_ENABLED: Airdrop to holders is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { HOLDER_DROP_ENABLED } = await import('./storeBuild');
    expect(HOLDER_DROP_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'HOLDER_DROP_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the sheet is only a lazy import behind the flag', () => {
    const v = src('../components/SendBsv21View.tsx');
    expect(v).not.toMatch(/^import [^;]*holderDrop\//m);
    expect(v).toMatch(/HOLDER_DROP_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\.\/mobile\/holderDrop\/HolderDropSheet'\)/);
  });
});

describe('BPOSITIVE_ENABLED: bPositive is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { BPOSITIVE_ENABLED } = await import('./storeBuild');
    expect(BPOSITIVE_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'BPOSITIVE_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the page is only a lazy import behind the flag, and the tile sits behind the literal env check', () => {
    const r = src('./tabs/MobileRoutes.tsx');
    expect(r).not.toMatch(/^import [^;]*bpositive\//m);
    expect(r).toMatch(/BPOSITIVE_ENABLED \? lazy\(\(\) => import\('\.\.\/bpositive\/BPositivePage'\)\)/);
    const b = src('./bapps.ts');
    const at = b.indexOf("name: 'bPositive'");
    expect(at).toBeGreaterThan(0);
    expect(b.lastIndexOf("import.meta.env.VITE_CHANNEL === 'android-play'", at)).toBeGreaterThan(
      b.lastIndexOf("name: '", at - 1),
    );
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
    expect(src('./pots/pots.ts')).toMatch(/ownServicePayees[^=]*=[^=]*=>\s*SUBSCRIPTIONS_ENABLED\s*\?/);
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
    expect(t.agent).toBe('b, or use your own AI key');
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
  test('Swap: SWAP_ENABLED mirrors MARKET_ENABLED; the balance header always has the price line; Swap is only the promo card (dropped in the store edition)', async () => {
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
    // Top row restored (19 Oct 2026): price tile (opens Portfolio) · Buy BSV · History.
    expect(bar).toMatch(
      /<div className="bw-toprow[^"]*">\s*<PriceCell rate=\{rate\} onOpen=\{\(\) => setPortfolioOpen\(true\)\}/,
    );
    expect(bar).toMatch(/<HistoryButton className=\{CELL\} \/>/);
    expect(bar).toMatch(/import\('..\/portfolio\/PortfolioScreen'\)/);
    // All cards | Swap row (15 Oct 2026): Swap only when swapOn; All cards only with the balance cards (bWalletX).
    expect(bar).toMatch(/swapRowButtons\(swapOn && !!SwapPromo, false\)/);
    // Permanent card (owner, 10 Oct 2026): no × and no dismissed flag, so nobody is left without a swap entry.
    const promo = src('./swap/SwapPromo.tsx');
    expect(promo).not.toMatch(/Hide the swap card|setDismissed|localStorage/);
    expect(bar).not.toMatch(/swapPromoDismissed/);
    const w = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
    expect(w).not.toMatch(/BsvHistoryBar/);
    expect(bar).toMatch(/BUY_CRYPTO_ENABLED \? 'Buy BSV' : 'Receive'/);
    expect(bar).toMatch(/BUY_CRYPTO_ENABLED && open && \(/);
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
    expect(t.route).toBe('/m/exchange');
  });
  test('the Market route and its chunk are behind MARKET_ENABLED', () => {
    const r = src('./tabs/MobileRoutes.tsx');
    expect(r).toMatch(/const ExchangePage = MARKET_ENABLED \? lazy\(/);
    expect(r).toMatch(/\{ExchangePage && <Route path="exchange\/\*"/);
    expect(r).toMatch(/\{ExchangePage && <Route path="market\/\*"/);
  });
  test('Buy / Get PNEEs / Back PNEEs entry points are behind MARKET_ENABLED', () => {
    expect(src('./chat/OpenTokenRoomButton.tsx')).toMatch(/if \(!id \|\| !MARKET_ENABLED\) return null/);
    expect(src('./wallet/FriendToken.tsx')).toMatch(/!MARKET_ENABLED \? null/);
    const cards = src('./wallet/DefaultTokenCards.tsx');
    expect(cards).toMatch(/PNEE_TOKEN_ID && MARKET_ENABLED/);
    expect(cards).toMatch(/MARKET_ENABLED\s*\?\s*\{ label: BACK_PNEE_LABEL/);
    expect(src('./locks/LockScreen.tsx')).toMatch(/MARKET_ENABLED && backPnee === 'card' && \(\s*<BackPneeSheet/);
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
    expect(x).toContain("bappIconUrl('bexchange')");
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

describe('BSPACES_ENABLED: full bSpaces (token rooms, paid entry) is bWalletX only', () => {
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
    expect(src('./BrowserPage.tsx')).toContain(
      'BSPACES_ENABLED ? [AGENT_TILE, BPICS_TILE, BSPACES_TILE] : [AGENT_TILE, BPICS_TILE]',
    );
    expect(src('./tabs/MobileRoutes.tsx')).toContain(
      "BSPACES_ENABLED ? lazy(() => import('../spaces/SpacesPage')) : null",
    );
    // The in-room banner: bWalletX in every room; the store edition only in open rooms (free Spaces).
    expect(src('./tabs/ChatPage.tsx')).toMatch(
      /\(BSPACES_ENABLED \|\| roomSpacesAllowed\(room\)\) && \(\s*<LiveBanner/,
    );
    // Paid entry stays bWalletX only.
    expect(src('./spaces/LiveBanner.tsx')).toContain("BSPACES_ENABLED ? lazy(() => import('./DoorKeeper')");
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

describe('Free Spaces in the store edition (owner, 10 Oct 2026)', () => {
  test('open rooms and the Lounge allow a Space in a store build; token rooms do not', async () => {
    const { roomSpacesAllowed, isOpenRoom, FREE_SPACES_ENABLED } = await import('./storeBuild');
    expect(FREE_SPACES_ENABLED).toBe(true);
    const lounge = { ticker: 'LOUNGE', metadata: null };
    const open = { ticker: 'CHAT1', metadata: { kind: 'open', open: { visibility: 'public' } } };
    const token = { ticker: 'SATOSHI', metadata: { tokenGate: { key: 'bsv21:x_0', symbol: 'SATOSHI' } } };
    const openButGated = { ticker: 'ODD', metadata: { kind: 'open', tokenGate: { key: 'k' } } };
    expect(isOpenRoom(lounge)).toBe(true);
    expect(isOpenRoom(open)).toBe(true);
    expect(isOpenRoom(token)).toBe(false);
    expect(isOpenRoom(openButGated)).toBe(false);
    expect(isOpenRoom(null)).toBe(false);
    for (const r of [lounge, open]) expect(roomSpacesAllowed(r, true)).toBe(true);
    for (const r of [token, openButGated]) expect(roomSpacesAllowed(r, true)).toBe(false);
    for (const r of [lounge, open, token]) expect(roomSpacesAllowed(r, false)).toBe(true);
  });
  test('token rooms point store users to bWalletX or bchatx.com', async () => {
    const { storeTokenSpaceNote, STORE_ROOM_NOTE } = await import('./storeBuild');
    expect(storeTokenSpaceNote('SATOSHI')).toBe(
      'This room is for $SATOSHI holders. Open it in bWalletX or on bchatx.com.',
    );
    expect(storeTokenSpaceNote()).toContain('token holders');
    expect(STORE_ROOM_NOTE).toContain('bchatx.com');
  });
});

describe('PAY_STREAM_ENABLED: pay-per-second streaming is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env; the album and the sweeper are behind it', async () => {
    const { PAY_STREAM_ENABLED } = await import('./storeBuild');
    expect(PAY_STREAM_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'PAY_STREAM_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
    expect(src('./media/MediaPage.tsx')).toContain(
      "PAY_STREAM_ENABLED ? lazy(() => import('./stream/StreamAlbum')) : null",
    );
    expect(src('./notify/NotifyEngine.tsx')).toContain('if (!PAY_STREAM_ENABLED || isLocked || !wallet) return;');
  });
});

describe('BMINT_NOTES_ENABLED: the bMint banknote designer is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { BMINT_NOTES_ENABLED } = await import('./storeBuild');
    expect(BMINT_NOTES_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'BMINT_NOTES_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  // Evaluate the flag's own expression against each env, so both values are tested.
  const flagFor = (env: Record<string, string>) => {
    const expr = /export const BMINT_NOTES_ENABLED: boolean = ([^;]*);/s
      .exec(src('./storeBuild.ts'))![1]
      .replace(/import\.meta\.env/g, 'env');
    return new Function('env', `return ${expr};`)(env) as boolean;
  };
  test.each([
    [{ VITE_STORE_BUILD: '1' }, false],
    [{ VITE_CHANNEL: 'ios-store' }, false],
    [{ VITE_CHANNEL: 'android-play' }, false],
    [{ VITE_CHANNEL: 'direct' }, true],
    [{}, true],
  ])('%o → %p', (env, enabled) => {
    expect(flagFor(env)).toBe(enabled);
  });
  test('the Notes chunk is a lazy import behind the flag', () => {
    expect(src('./bmint/BmintPage.tsx')).toMatch(
      /BMINT_NOTES_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\/notes\/NotesPage'\)\)/,
    );
  });
});

describe('USER_NOTES_ENABLED: Make your own note is off by default and never in a store build', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const flagFor = (env: Record<string, string>) => {
    const expr = /export const USER_NOTES_ENABLED: boolean =([^;]*);/s
      .exec(src('./storeBuild.ts'))![1]
      .replace(/import\.meta\.env/g, 'env');
    return new Function('env', `return (${expr});`)(env) as boolean;
  };
  test.each([
    [{}, false],
    [{ VITE_CHANNEL: 'direct' }, false],
    [{ VITE_BMINT_USER_NOTES: '1' }, true],
    [{ VITE_BMINT_USER_NOTES: '1', VITE_STORE_BUILD: '1' }, false],
    [{ VITE_BMINT_USER_NOTES: '1', VITE_CHANNEL: 'ios-store' }, false],
    [{ VITE_BMINT_USER_NOTES: '1', VITE_CHANNEL: 'android-play' }, false],
  ])('%o → %p', (env, enabled) => {
    expect(flagFor(env)).toBe(enabled);
  });
  test('the studio is a lazy import behind the flag, and its hub tile is behind the literal flag', () => {
    const page = src('./bmint/BmintPage.tsx');
    expect(page).toMatch(/USER_NOTES_ENABLED\s*\?\s*lazy\(\(\) => import\('\.\/make\/MakeNotePage'\)\)/);
    expect(page).toMatch(/\.\.\.\(USER_NOTES_ENABLED\s*\?/);
  });
});

describe('PLACEMENT_ENABLED: bShares (securities) is bWalletX only', () => {
  test('off exactly when the store flag is on', async () => {
    const { PLACEMENT_ENABLED } = await import('./storeBuild');
    expect(PLACEMENT_ENABLED).toBe(!STORE_BUILD);
  });
});

/** Feed › bMovies (tokenised clip pitches) is bWalletX only: no reel, no feed entry in a store build. */
describe('BMOVIES_FEED_ENABLED: the bMovies feed is not in a store build', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const feedIds = (env: Record<string, string>) => {
    const r = Bun.spawnSync(
      [
        'bun',
        '-e',
        "const f = await import('./src/mobile/feed/feeds.ts'); console.log(JSON.stringify(f.FEEDS.map((x) => x.id)));",
      ],
      { env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env } },
    );
    return JSON.parse(r.stdout.toString()) as string[];
  };
  test('inverse of STORE_BUILD, from the same literal env', async () => {
    const { BMOVIES_FEED_ENABLED } = await import('./storeBuild');
    expect(BMOVIES_FEED_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'BMOVIES_FEED_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('store builds list no bMovies feed; bWalletX does', () => {
    expect(feedIds({ VITE_STORE_BUILD: '1' })).not.toContain('bmovies');
    expect(feedIds({ VITE_CHANNEL: 'ios-store' })).not.toContain('bmovies');
    expect(feedIds({ VITE_CHANNEL: 'android-play' })).not.toContain('bmovies');
    expect(feedIds({})).toContain('bmovies');
  });
  test('adult-leaning brands (cherryx, aigf) are in no build; the store keeps the other bApp feeds', () => {
    for (const env of [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, {}]) {
      const ids = feedIds(env);
      expect(ids).not.toContain('cherryx');
      expect(ids).not.toContain('aigf');
      expect(ids).toContain('bnews');
      expect(ids).toContain('bmusic');
    }
  });
  test('the reel is a lazy chunk behind the flag and the feed entry is data behind it', () => {
    const page = src('./feed/FeedPage.tsx');
    expect(page).toMatch(
      /const BmoviesReel = BMOVIES_FEED_ENABLED \? lazy\(\(\) => import\('\.\/bmovies\/BmoviesReel'\)\) : null;/,
    );
    expect(page).not.toMatch(/^import (?!type )[^;]*from '\.\/bmovies\//m);
    expect(src('./feed/feeds.ts')).toContain("BMOVIES_FEED_ENABLED ? [['bmovies', 'bMovies'");
    expect(src('./feed/FeedPicker.tsx')).not.toMatch(/from '\.\/bmovies\//);
  });
  test('the store audit lists the bMovies grep strings', () => {
    expect(readFileSync(new URL('../../docs/STORE-AUDIT.md', import.meta.url), 'utf8')).toContain(
      'api/feed?cursor|tweet-video|tweet-result|Open bmovies.app|bitsign/bmovies',
    );
  });
});

/** Feed › bExchange (the token reel) is bWalletX only; Feed › bApps is in every build without Tokenise in a store build. */
describe('BEX_REEL_ENABLED: the bExchange reel is not in a store build', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const feedIds = (env: Record<string, string>) => {
    const r = Bun.spawnSync(
      [
        'bun',
        '-e',
        "const f = await import('./src/mobile/feed/feeds.ts'); console.log(JSON.stringify(f.FEEDS.map((x) => x.id)));",
      ],
      { env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env } },
    );
    return JSON.parse(r.stdout.toString()) as string[];
  };
  test('inverse of STORE_BUILD, from the same literal env', async () => {
    const { BEX_REEL_ENABLED } = await import('./storeBuild');
    expect(BEX_REEL_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'BEX_REEL_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('store builds list bApps but no bExchange feed; bWalletX lists both, bApps right after Home', () => {
    for (const env of [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }]) {
      const ids = feedIds(env);
      expect(ids).not.toContain('bexchange');
      expect(ids.slice(0, 2)).toEqual(['home', 'bapps']);
    }
    const x = feedIds({});
    expect(x).toContain('bexchange');
    expect(x.slice(0, 2)).toEqual(['home', 'bapps']);
  });
  test('the reel is a lazy chunk behind the flag; Tokenise is behind MARKET_ENABLED', () => {
    const page = src('./feed/FeedPage.tsx');
    expect(page).toMatch(/const BexReel = BEX_REEL_ENABLED \? lazy\(\(\) => import\('\.\/reels\/BexReel'\)\) : null;/);
    expect(page).not.toMatch(/^import (?!type )[^;]*from '\.\/reels\//m);
    expect(src('./feed/feeds.ts')).toContain("BEX_REEL_ENABLED ? [['bexchange', 'bExchange'");
    const bapps = src('./feed/reels/BappsReel.tsx');
    expect(bapps).toContain("const LAUNCH_ROUTE = MARKET_ENABLED ? '/m/exchange/launchpad/new' : '';");
    expect(bapps).not.toMatch(/from '\.\.\/\.\.\/exchange\//);
  });
  test('the store audit lists the bExchange reel grep strings', () => {
    expect(readFileSync(new URL('../../docs/STORE-AUDIT.md', import.meta.url), 'utf8')).toContain(
      'Advert made by the creator|Tokens can lose all their value|Every token, one card each',
    );
  });
});

describe('BALANCE_CARDS_ENABLED: balance cards are bWalletX only', () => {
  test('off exactly when the store flag is on', async () => {
    const { BALANCE_CARDS_ENABLED } = await import('./storeBuild');
    expect(BALANCE_CARDS_ENABLED).toBe(!STORE_BUILD);
  });
});

describe('THEME_ORDERS_ENABLED: Get your own theme ($99 a year to bCorp) is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { THEME_ORDERS_ENABLED } = await import('./storeBuild');
    expect(THEME_ORDERS_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'THEME_ORDERS_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the sheet is only a lazy import behind the flag', () => {
    const lazyLine = "THEME_ORDERS_ENABLED ? lazy(() => import('../themeOrder/ThemeOrderSheet')) : null";
    expect(src('./theme/ThemeSheet.tsx')).toContain(lazyLine);
    expect(src('../pages/Settings.tsx')).toContain(lazyLine.replace('../themeOrder', '../mobile/themeOrder'));
    expect(src('../pages/Settings.tsx')).not.toMatch(/^import .*themeOrder/m);
  });
});

describe('THEME_STORE_PAID_ENABLED: store builds show Free themes only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { THEME_STORE_PAID_ENABLED } = await import('./storeBuild');
    expect(THEME_STORE_PAID_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'THEME_STORE_PAID_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('bStore is only a lazy chunk behind the flag; store builds go home', () => {
    const page = src('./themeStore/ThemeStorePage.tsx');
    expect(page).toContain("THEME_STORE_PAID_ENABLED ? lazy(() => import('./StoreFront')) : null");
    expect(page).not.toMatch(/^import .*StoreFront/m);
    expect(page).not.toMatch(/Sell|Be the first|Selling opens soon|\$99/);
  });
});

describe('App Review 3.1.5(iii): no exchange surfaces in a store build', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('the ChangeNOW swap watcher is a no-op unless SWAP_ENABLED, and its module has no side effects', () => {
    expect(src('./wallet/BuyBsv.tsx')).toContain('SWAP_ENABLED ? useSwapWatcherImpl : () => noSwaps');
    expect(src('./swap/useSwapWatcher.ts')).toContain('/* @__PURE__ */ new SwapApi()');
    expect(src('./swap/swapApi.ts')).toContain('/* @__PURE__ */ new Set(');
  });
  test('the bApps reel has no "Trade tokens" text outside MARKET_ENABLED', () => {
    expect(src('./feed/reels/bappsCards.ts')).toMatch(/MARKET_ENABLED \? \{ bExchange: 'Trade tokens/);
  });
  test('selling names, agent buying and trading strategies are gated by MARKET_ENABLED', () => {
    expect(src('./names/store/NameStorePage.tsx')).toContain('MARKET_ENABLED && o.listedSats ?');
    expect(src('./agents/agentTrade.ts')).toContain("if (!MARKET_ENABLED && a.kind !== 'send')");
    expect(src('./agents/AgentsScreen.tsx')).toContain('{MARKET_ENABLED && <StrategySection id={id} />}');
    expect(src('./agent/AgentConversation.tsx')).toContain('!MARKET_ENABLED || baseSystem === BWALLET_GUIDE');
    expect(src('./agent/guide.ts')).toContain('MARKET_ENABLED ? MARKET_LINE : STORE_MARKET_LINE');
  });
});

describe('TWETCH_POST_ENABLED: Post to Twetch is bWalletX only', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const cond = (text: string, name: string) =>
    (new RegExp(`export const ${name}: boolean =\\s*!?\\(?([^;]*?)\\)?;`, 's').exec(text)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  test('inverse of STORE_BUILD, from the same env', async () => {
    const { TWETCH_POST_ENABLED } = await import('./storeBuild');
    expect(TWETCH_POST_ENABLED).toBe(!STORE_BUILD);
    const s = src('./storeBuild.ts');
    expect(cond(s, 'TWETCH_POST_ENABLED')).toBe(cond(s, 'STORE_BUILD'));
  });
  test('the calls, the sheet and the Settings row all sit behind it', () => {
    expect(src('./twetch/twetchCalls.ts')).toContain('deps.enabled ?? TWETCH_POST_ENABLED');
    expect(src('./phone/PhoneShell.tsx')).toContain('TWETCH_POST_ENABLED && <TwetchHost />');
    expect(src('./settings/FeedSettings.tsx')).toContain("TWETCH_POST_ENABLED && screen === 'twetch'");
  });
});

// ── Store gates of 16 Nov 2026 (CEO rulings): market targets, catalogue wording, the PNEEs row, games ──────────
/** The catalogues as a build of the given env sees them (a fresh process, so the literal env checks apply). */
const catalogues = (env: Record<string, string>) => {
  const code = `
    const b = await import('./src/mobile/bapps.ts'); const r = await import('./src/mobile/radarApps.ts');
    const s = await import('./src/mobile/storeBuild.ts'); const st = await import('./src/mobile/bappStandard.ts');
    const g = await import('./src/mobile/games/gamesCatalog.ts'); const o = await import('./src/mobile/ownerApps.ts');
    const cards = await import('./src/mobile/feed/reels/bappsCards.ts');
    const bapps = b.BAPP_GROUPS.flatMap((x) => b.bappsIn(x.id)).filter((a) => s.appsTileShown(a.name));
    const std = st.visibleApps([...st.BX_APPS, ...st.COMMERCIAL_APPS], s.STORE_BUILD);
    const groups = r.RADAR_GROUPS.filter((x) => s.radarGroupShown(x.id));
    const radar = r.RADAR_APPS.filter((a) => s.radarGroupShown(a.group));
    console.log(JSON.stringify({
      store: s.STORE_BUILD, gamesOn: s.GAMES_ENABLED,
      bapps: bapps.map((a) => [a.name, a.verb, a.url]), coming: b.COMING_BAPPS.map((a) => [a.name, a.verb]),
      std: std.map((a) => [a.name, a.verb, a.category, a.url]),
      groups: groups.map((x) => x.label), radar: radar.map((a) => [a.name, a.desc, a.url]),
      owner: o.OWNER_APPS.map((a) => a.name), allRadar: r.RADAR_APPS.map((a) => a.name),
      games: g.GAMES.map((a) => [a.name, a.desc, a.url, a.source]), shownGames: g.gamesFor().map((a) => a.name),
      gameSources: g.GAME_SOURCES.map((x) => x.label), about: cards.BAPP_ABOUT,
    }));`;
  const r = Bun.spawnSync(['bun', '-e', code], {
    env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
  });
  return JSON.parse(r.stdout.toString()) as {
    store: boolean;
    gamesOn: boolean;
    bapps: string[][];
    coming: string[][];
    std: string[][];
    groups: string[];
    radar: string[][];
    owner: string[];
    allRadar: string[];
    games: string[][];
    shownGames: string[];
    gameSources: string[];
    about: Record<string, string>;
  };
};
const STORE_ENVS = [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }];
const srcOf = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('gate (a): no market, exchange or token-sale target in a store build', () => {
  const X_ONLY_OWNER = [
    'BUDZ',
    'BUDGIRLS',
    'Zanaadu',
    'GZONE.ROCKS',
    'GMEHL.ROCKS',
    'UWUTV',
    'TWETCH.ROCKS',
    'AIGF',
    '1satsocial',
    'Zero Dice',
    'Ninja Punk Girls',
  ];
  const X_ONLY_RADAR = ['ZedVibe', 'ToDo', 'DXS'];
  const X_ONLY_BAPPS = ['bMoviesX', 'bMusicX', 'bDNS', 'bGames', 'bExchange'];
  const X_ONLY_STD = ['bMoviesX', 'bMusicX', 'bDojoX', 'bStoreX', 'Ninja Punk Girls'];
  test('store build: the token sites, trading platforms and exchange-like bApps are not in the data', () => {
    for (const env of STORE_ENVS) {
      const c = catalogues(env);
      expect(c.store).toBe(true);
      for (const n of [...X_ONLY_OWNER, ...X_ONLY_RADAR]) expect(c.allRadar).not.toContain(n);
      expect(c.owner).toEqual(['TankScope', 'VexVoid']);
      for (const n of X_ONLY_BAPPS) expect(c.bapps.map((a) => a[0])).not.toContain(n);
      for (const n of X_ONLY_STD) expect(c.std.map((a) => a[0])).not.toContain(n);
      // What stays.
      for (const n of ['bChatX', 'bMintX', 'bWriterX', 'bMailX', 'bSheets', 'bDriveX', 'bPhotos', 'bMaps'])
        expect(c.bapps.map((a) => a[0])).toContain(n);
      for (const n of ['HandCash', 'WhatsOnChain', 'Tempo']) expect(c.allRadar).toContain(n);
    }
  });
  test('bWalletX build: every one of them is still listed', () => {
    const c = catalogues({});
    expect(c.store).toBe(false);
    for (const n of [...X_ONLY_OWNER, ...X_ONLY_RADAR]) expect(c.allRadar).toContain(n);
    expect(c.owner.slice(0, 11)).toEqual(X_ONLY_OWNER);
    for (const n of X_ONLY_BAPPS) expect(c.bapps.map((a) => a[0])).toContain(n);
    for (const n of X_ONLY_STD) expect(c.std.map((a) => a[0])).toContain(n);
    expect(c.bapps.slice(0, 4).map((a) => a[0])).toEqual(['bChatX', 'bMoviesX', 'bMusicX', 'bMintX']);
  });
  test('Apps › More apps: 1Sat Market and 1satsocial are data only behind MARKET_ENABLED', () => {
    const p = srcOf('./BrowserPage.tsx');
    expect(p).toMatch(
      /\.\.\.\(MARKET_ENABLED\s*\? \[\{ name: '1Sat Market', link: 'https:\/\/1sat\.market\/'[^\]]*\]\s*: \[\]\)/,
    );
    expect(p).toMatch(/\.\.\.\(MARKET_ENABLED \? \[\{ name: '1satsocial', [^\]]*\] : \[\]\)/);
    // Nowhere else in the file as a tile, and the address-bar hint names it only in bWalletX.
    expect(p.match(/name: '1Sat Market'/g)).toHaveLength(1);
    expect(p).toContain(
      "MARKET_ENABLED ? 'Enter a web address, like 1sat.market' : 'Enter a web address, like whatsonchain.com'",
    );
    expect(p).toContain('.filter((a) => storeLinkShown(a.link))');
    // The token panel's link to the token's market page too.
    expect(srcOf('./tokens/TokenIdPanel.tsx')).toContain("...(MARKET_ENABLED ? [['1sat.market', links.market]] : []),");
  });
  test('inherited featured apps: the marketplace and the prize arcade are hidden by address in a store build only', async () => {
    const { storeLinkShown, STORE_HIDDEN_LINK_HOSTS } = await import('./storeBuild');
    const { featuredApps } = await import('../utils/constants');
    const links = featuredApps.map((a: { link: string }) => a.link);
    expect(links.some((l: string) => /takeitnft\.com/.test(l))).toBe(true);
    for (const l of links) expect(storeLinkShown(l, false)).toBe(true);
    const store = links.filter((l: string) => storeLinkShown(l, true));
    expect(store.join(' ')).not.toMatch(/takeitnft|hastearcade|market/i);
    expect(storeLinkShown('https://www.takeitnft.com/marketplace/global', true)).toBe(false);
    expect(storeLinkShown('https://hastearcade.com', true)).toBe(false);
    expect(storeLinkShown('https://whatsonchain.com', true)).toBe(true);
    expect(storeLinkShown('not a url', true)).toBe(false);
    expect(STORE_HIDDEN_LINK_HOSTS).toEqual(['hastearcade.com', 'takeitnft.com']);
  });
});

describe('gate (b): store catalogue wording names no trading, stakes, backing or tokenising', () => {
  const X_VERBS: [string, string][] = [
    ['bChatX', 'Chat rooms, Spaces and feeds for every token'],
    ['bMoviesX', 'Watch and back tokenised films'],
    ['bMusicX', 'Tokenise your music; fans who hold it make the video with you'],
    ['bMintX', 'Design, stamp and mint tokens, currency and media on-chain'],
    ['bDNS', 'Register and trade names on Bitcoin'],
    ['bPhotos', 'Turn photos into tradable NFTs'],
    ['bGames', 'Play games with real stakes'],
  ];
  test('the word list catches the wording it is for, and leaves ordinary wording alone', async () => {
    const { storeBannedWord } = await import('./storeBuild');
    for (const [, verb] of X_VERBS)
      expect(storeBannedWord(verb) ?? (verb.includes('currency') ? 'ok' : null)).not.toBeNull();
    for (const t of [
      'Earn Bitcoins on Brokerless Trading Platform',
      'Buy and sell coins',
      'Swap into BSV',
      'A launchpad for coins',
      'gamified rev share',
      'hold her ticker',
      'back her token',
      'Token rooms for holders',
      'An exchange',
      'Markets & collectibles',
      'Win prizes',
      'with a reward',
    ])
      expect(storeBannedWord(t)).not.toBeNull();
    for (const t of [
      'Store and share files on-chain',
      'Email that pays and gets paid',
      'Mint tokens and media on-chain',
      'Find places that take Bitcoin',
      'Turn photos into NFTs',
      'A marketing tool',
      'Go back to the wallet',
      'Traditional payments',
    ])
      expect(storeBannedWord(t)).toBeNull();
  });
  test('store build: every string the catalogue can show passes the word list, and none names bWalletX', async () => {
    const { storeBannedWord } = await import('./storeBuild');
    for (const env of STORE_ENVS) {
      const c = catalogues(env);
      const strings = [
        ...c.bapps.map((a) => `${a[0]}: ${a[1]}`),
        ...c.coming.map((a) => `${a[0]}: ${a[1]}`),
        ...c.std.map((a) => `${a[0]}: ${a[1]} [${a[2]}]`),
        ...c.groups,
        ...c.radar.map((a) => `${a[0]}: ${a[1]}`),
        ...c.games.map((a) => `${a[0]}: ${a[1]}`),
        ...c.gameSources,
        // Feed › bApps: one card per catalogue app, with this line on it.
        ...Object.entries(c.about).map(([k, v]) => `${k}: ${v}`),
      ];
      for (const a of c.bapps) expect(c.about[a[0]]?.length ?? 0).toBeGreaterThan(10);
      for (const n of ['bMoviesX', 'bMusicX', 'bDNS', 'bGames', 'bExchange']) expect(c.about[n]).toBeUndefined();
      expect(c.about.bChatX).toBe('Group chats, open rooms and feeds.');
      expect(strings.length).toBeGreaterThan(120);
      const bad = strings.map((t) => [t, storeBannedWord(t)]).filter((x) => x[1]);
      expect(bad).toEqual([]);
      expect(strings.filter((t) => /bWalletX/.test(t))).toEqual([]);
      // Addresses too: no tile opens a market, exchange, swap or launchpad address.
      const urls = [...c.bapps.map((a) => a[2]), ...c.std.map((a) => a[3]), ...c.radar.map((a) => a[2])];
      expect(urls.filter((u) => /exchang|market|swap|launchpad/i.test(u))).toEqual([]);
      const verbs = Object.fromEntries(c.bapps.map((a) => [a[0], a[1]]));
      expect(verbs.bChatX).toBe('Chat with friends, groups and open rooms');
      expect(verbs.bMintX).toBe('Mint tokens and media on-chain');
      expect(verbs.bPhotos).toBe('Turn photos into NFTs');
      const std = Object.fromEntries(c.std.map((a) => [a[0], `${a[1]} [${a[2]}]`]));
      expect(std.bChatX).toBe('Chat with friends, groups and open rooms [Talk]');
      expect(std.bMintX).toBe('Mint your art, media and archives on-chain [Make & own]');
      expect(std.bCalX).toBe('Shared calendars and bookings [Work]');
      expect(std.bSocialX).toBe('Public Spaces and posts [Talk]');
    }
  });
  test('bWalletX build: the wording is what it was', () => {
    const c = catalogues({});
    const verbs = Object.fromEntries(c.bapps.map((a) => [a[0], a[1]]));
    for (const [name, verb] of X_VERBS) expect(verbs[name]).toBe(verb);
    const std = Object.fromEntries(c.std.map((a) => [a[0], `${a[1]} [${a[2]}]`]));
    expect(std.bChatX).toBe('Rooms, Spaces and feeds for every token [Talk]');
    expect(std.bSocialX).toBe('Spaces for every brand and token, in public [Talk]');
    expect(std.bMintX).toBe('Mint anything: art, media, coins and archives [Own & trade]');
    expect(std.bCalX).toBe('Paid bookings and shared calendars [Work]');
    expect(std.bMoviesX).toBe('Watch and back tokenised films [Watch & make]');
    expect(std.bDojoX).toBe('Train, compete and earn your belts [Watch & make]');
    expect(c.about.bChatX).toBe('Group chats, live audio Spaces and feeds, with a room for every token.');
    expect(c.about.bMoviesX).toBe('A feed of films and trailers you can watch, and back by buying their tokens.');
    expect(c.about.bMintX).toBe('Design and mint your own tokens, notes and media on Bitcoin.');
    expect(c.about.bDNS).toBe('Register names on Bitcoin and trade them.');
    expect(c.about.bPhotos).toBe('Turn your photos into NFTs that can be traded.');
    expect(c.about.bGames).toBe('Play games where you can stake BSV.');
    expect(Object.keys(c.about)).toHaveLength(30);
  });
  test('the store wording and the gated entries are behind literal env checks, so a store bundle has neither', () => {
    for (const f of ['./bapps.ts', './bappStandard.ts', './ownerApps.ts', './radarApps.ts']) {
      const t = srcOf(f);
      // Each banned line of data sits inside a literal-env conditional (a spread or a ternary), never a plain entry.
      expect(t).toMatch(/import\.meta\.env\.VITE_STORE_BUILD === '1'/);
    }
    expect(srcOf('./bapps.ts')).toMatch(
      /android-play'\s*\? 'Turn photos into NFTs'\s*: 'Turn photos into tradable NFTs'/,
    );
  });
});

describe('gate (c): the PNEEs default row is not in a store build; a held balance always shows', () => {
  test('pneeRowShown, both editions', async () => {
    const { pneeRowShown } = await import('./storeBuild');
    // bWalletX: always, at zero too.
    expect(pneeRowShown(0, false)).toBe(true);
    expect(pneeRowShown(12.5, false)).toBe(true);
    // Store build: only someone who holds PNEEs (indexed or still indexing).
    expect(pneeRowShown(0, true)).toBe(false);
    expect(pneeRowShown(0.01, true)).toBe(true);
    expect(pneeRowShown(500, true)).toBe(true);
  });
  test('the Wallet uses it for the PNEEs row only; the balance is still published and MNEE has no such gate', () => {
    const t = srcOf('./wallet/DefaultTokenCards.tsx');
    expect(t).toMatch(/\{pneeRowShown\(pnee\) && \(\s*<CoinRow id="pnee">/);
    expect(t.match(/pneeRowShown\(/g)).toHaveLength(1);
    // `pnee` is the indexed balance, else what is still indexing: both count as held.
    expect(t).toContain('const pnee = indexed > 0 ? indexed : pending;');
    expect(t).toContain("useEffect(() => publishBalance('pnee', pnee, 'PNEEs'), [pnee]);");
    const w = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
    expect(w).toContain('ticker="MNEE USD"');
    expect(w).not.toMatch(/pneeRowShown|mneeRowShown/);
    expect(w).toContain('onGetMneeClick={BUY_CRYPTO_ENABLED ?');
  });
});

describe('gate (d): no games in a store build (third-party games out entirely; none of ours is marked storeSafe)', () => {
  test('GAMES_ENABLED is the inverse of STORE_BUILD, from the same literal env', () => {
    for (const env of STORE_ENVS) expect(catalogues(env).gamesOn).toBe(false);
    expect(catalogues({}).gamesOn).toBe(true);
    expect(srcOf('./storeBuild.ts')).toMatch(
      /export const GAMES_ENABLED: boolean = !\(\s*import\.meta\.env\.VITE_STORE_BUILD === '1' \|\|/,
    );
  });
  test('store build: no game data, no Games group, screen, page, route or tile', async () => {
    const { STORE_HIDDEN_SCREENS, STORE_HIDDEN_RADAR_GROUPS, screenShown, radarGroupShown } =
      await import('./storeBuild');
    for (const env of STORE_ENVS) {
      const c = catalogues(env);
      expect(c.games).toEqual([]);
      expect(c.shownGames).toEqual([]);
      expect(c.groups).not.toContain('Games');
      expect(c.bapps.map((a) => a[0])).not.toContain('bGames');
      expect(JSON.stringify(c)).not.toMatch(/real stakes|Paiybit arcade|PixelWar|Midnight Pass/);
    }
    expect(STORE_HIDDEN_SCREENS).toContain('games');
    expect(STORE_HIDDEN_RADAR_GROUPS).toContain('games');
    expect(screenShown('games', true)).toBe(false);
    expect(radarGroupShown('games', true)).toBe(false);
    const p = srcOf('./BrowserPage.tsx');
    expect(p).toMatch(
      /const PAGES: readonly string\[\] = GAMES_ENABLED\s*\? \['Home', 'bApps', 'Other apps', 'Games'\]\s*: \['Home', 'bApps', 'Other apps'\];/,
    );
    expect(p).toContain('if (GAMES_ENABLED && i === 3) {');
    expect(p).toContain("GAMES_ENABLED && only === 'games' ? (");
    expect(p).toContain('{GAMES_ENABLED && /^games$/i.test(screenTitle(x, i).trim()) && <BGamesHero top={false} />}');
    expect(srcOf('./tabs/MobileRoutes.tsx')).toMatch(
      /path="games"\s*element=\{GAMES_ENABLED \? <BrowserPage only="games" \/> : <Navigate to="\/m\/apps" replace \/>\}/,
    );
    expect(srcOf('./wide/WideShell.tsx')).toContain("to: '/m/games', hidden: !GAMES_ENABLED }");
    expect(srcOf('./games/gamesCatalog.ts')).toMatch(/export const GAMES: Game\[\] = !GAMES_ENABLED\s*\? \[\]/);
  });
  test('bWalletX build: the games, the Games group and screen, and the bGames tile are all still there', async () => {
    const { screenShown, radarGroupShown } = await import('./storeBuild');
    const c = catalogues({});
    const names = c.games.map((a) => a[0]);
    for (const n of [
      'Snake',
      '2048',
      'Ninja Punk Girls',
      'Satoshi Pong',
      'Haste Arcade',
      'Midnight Pass',
      'PixelWar',
      'PeerJump',
    ])
      expect(names).toContain(n);
    expect(c.shownGames).toEqual(names);
    expect(c.games.filter((a) => a[3] === 'tokenblaster')).toHaveLength(18);
    expect(c.groups).toContain('Games');
    expect(c.gameSources).toEqual(['bGames', 'TokenBlaster arcade', 'More BSV games']);
    expect(c.bapps.find((a) => a[0] === 'bGames')?.[1]).toBe('Play games with real stakes');
    expect(screenShown('games', false)).toBe(true);
    expect(radarGroupShown('games', false)).toBe(true);
  });
});

// ── Store gates, second round (16 Nov 2026): priced names, the domain mint step, the marketplace address ───────
describe('priced names are bWalletX only: a store build offers free handles and never pays for a name', () => {
  test('paidNameBlocked / paidNamesEnabled, both editions', async () => {
    const { paidNameBlocked, paidNamesEnabled, STORE_NAME_NOTE } = await import('./storeBuild');
    const fee = { address: '1FeeAddress', usd: 10 };
    expect(paidNamesEnabled(true)).toBe(false);
    expect(paidNamesEnabled(false)).toBe(true);
    // Store build: a name with a price is off; a free one (no fee) is fine.
    expect(paidNameBlocked(fee, true)).toBe(true);
    expect(paidNameBlocked(null, true)).toBe(false);
    expect(paidNameBlocked(undefined, true)).toBe(false);
    // bWalletX: nothing is blocked.
    expect(paidNameBlocked(fee, false)).toBe(false);
    expect(paidNameBlocked(null, false)).toBe(false);
    expect(STORE_NAME_NOTE).toBe('Not available in this edition');
  });
  test('which names carry a fee is the server price list: 5+ characters free, shorter ones priced', async () => {
    const { nameFeeFor } = await import('./names/paymail');
    const { paidNameBlocked } = await import('./storeBuild');
    const prices = { address: '1FeeAddress', tiers: { '1': 1000, '2': 1000, '3': 100, '4': 10 } };
    for (const n of ['a', 'ab', 'abc', 'abcd']) {
      expect(paidNameBlocked(nameFeeFor(prices, n), true)).toBe(true);
      expect(paidNameBlocked(nameFeeFor(prices, n), false)).toBe(false);
    }
    for (const n of ['alice', 'richard', 'a-long-name'])
      expect(paidNameBlocked(nameFeeFor(prices, n), true)).toBe(false);
  });
  test('payNameFee and addExtraName refuse in a store build before anything is priced or sent', async () => {
    const { payNameFee } = await import('./names/nameFee');
    const { addExtraName } = await import('./names/extraNames');
    let touched = 0;
    const trap = new Proxy({}, { get: () => ((touched += 1), () => Promise.reject(new Error('reached the wallet'))) });
    const ctx = { wallet: trap } as never;
    const f = (() => ((touched += 1), Promise.reject(new Error('reached the network')))) as never;
    const fee = { address: '1FeeAddress', usd: 10 };
    await expect(payNameFee(ctx, fee, 'abcd', true)).rejects.toThrow('Not available in this edition');
    await expect(
      addExtraName(ctx, f, 'abcd', { pence: 0, sats: 5000, to: '1FeeAddress', usd: 10, direct: true }, true),
    ).rejects.toThrow('Not available in this edition');
    await expect(addExtraName(ctx, f, 'abcd', { sats: 5000, to: '1FeeAddress' }, true)).rejects.toThrow(
      'Not available in this edition',
    );
    expect(touched).toBe(0);
    // bWalletX: the same calls go on to the wallet / the network (and fail there, in this test).
    await expect(payNameFee(ctx, fee, 'abcd', false)).rejects.not.toThrow('Not available in this edition');
    await expect(
      addExtraName(ctx, f, 'abcd', { pence: 0, sats: 5000, to: '1FeeAddress', usd: 10, direct: true }, false),
    ).rejects.not.toThrow('Not available in this edition');
  });
  test('every claim screen checks it before the fee sheet, and shows no price for a blocked name', () => {
    const g = srcOf('./names/GetYourName.tsx');
    expect(g).toMatch(
      /if \(!ownPaymail && paidNameBlocked\(nameFee\)\) return setMsg\(STORE_NAME_NOTE\);\s*if \(nameFee && !ownPaymail && !paid\) return setFeeConfirm\(true\);/,
    );
    const h = srcOf('./names/HandleFlow.tsx');
    expect(h).toContain('const feeOff = (n: string) => paidNameBlocked(feeFor(n));');
    expect(h).toMatch(
      /if \(feeOff\(order\[0\]\)\) setMsg\(STORE_NAME_NOTE\);\s*else if \(feeFor\(order\[0\]\)\) setFeeConfirm\(true\);/,
    );
    expect(h).toMatch(
      /if \(!fee\) return claim\(\{\}, name\);\s*if \(feeOff\(name\)\) return setMsg\(STORE_NAME_NOTE\);/,
    );
    expect(h).toContain(
      "feeOff(alias) ? STORE_NAME_NOTE : nameFee ? `${usdText(nameFee.usd)} · instant` : 'Free · instant'",
    );
    expect(h).toContain('feeOff(alias) ? setMsg(STORE_NAME_NOTE) : nameFee ? setFeeConfirm(true) : void claim()');
    // No price in a label for a blocked name: every usdText(nameFee.usd) is behind feeOff.
    expect(h.match(/usdText\(nameFee\.usd\)/g)).toHaveLength(3);
    expect(h.match(/nameFee && !feeOff\(alias\) \? ` · \$\{usdText\(nameFee\.usd\)\}` : ''/g)).toHaveLength(2);
    const w = srcOf('./settings/WalletNames.tsx');
    expect(w).toMatch(
      /if \(paidNameBlocked\(fee\)\) return setError\(STORE_NAME_NOTE\);\s*setNameFee\(fee\);\s*if \(fee\) return setFeeConfirm\(true\);/,
    );
    // The only callers of payNameFee are those two screens.
    expect(g.match(/payNameFee\(/g)).toHaveLength(1);
    expect(h.match(/payNameFee\(/g)).toHaveLength(1);
  });
});

describe('store wording and data, second round', () => {
  const textsOf = (env: Record<string, string>) => {
    const code = `
      const s = await import('./src/mobile/storeBuild.ts'); const r = await import('./src/mobile/chat/bappRooms.ts');
      const st = await import('./src/mobile/bappStandard.ts'); const c = await import('./src/utils/constants.ts');
      const i = await import('./src/mobile/brand/bappIcons/registry.ts'); const h = await import('./src/mobile/wallet/historyEvents.ts');
      const m = await import('./src/mobile/mint/mintCatalog.ts');
      console.log(JSON.stringify({
        domain: s.DOMAIN_MINT_ENABLED, marketApp: s.MARKET_APP_NAME, venues: s.LISTING_VENUES, url: c.ONE_SAT_MARKET_URL,
        purposes: r.BAPPS.map((b) => b.name + ': ' + b.purpose),
        std: [...st.BX_APPS, ...st.COMMERCIAL_APPS].map((a) => [a.name, a.verb, a.category]),
        icons: Object.values(i.BAPP_ICONS).map((d) => d.label ?? d.name ?? ''),
        history: h.inWalletAppOf({ description: 'Purchase 5 tokens for 100 sats' }),
        mint: JSON.stringify(m),
      }));`;
    const r = Bun.spawnSync(['bun', '-e', code], {
      env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
    });
    return JSON.parse(r.stdout.toString()) as {
      domain: boolean;
      marketApp: string;
      venues: string;
      url: string;
      purposes: string[];
      std: string[][];
      icons: string[];
      history: string;
      mint: string;
    };
  };
  test('store build: no marketplace address, no bExchange label, no dice, no "tokenise", safe room purposes', async () => {
    const { storeBannedWord } = await import('./storeBuild');
    for (const env of STORE_ENVS) {
      const t = textsOf(env);
      expect(t.domain).toBe(false);
      expect(t.marketApp).toBe('Marketplace');
      expect(t.history).toBe('Marketplace');
      expect(t.venues).toBe('the Market');
      expect(t.url).toBe('');
      expect(JSON.stringify(t)).not.toMatch(/1sat\.market|bExchange|Provably fair|Zero Dice|Tokenise|tokenise it/);
      // bApp room purposes are shown only where rooms are (BSPACES_ENABLED); the store bundle's copies are plain.
      expect(t.purposes.map((p) => [p, storeBannedWord(p)]).filter((x) => x[1])).toEqual([]);
      expect(t.purposes.filter((p) => /bWalletX/.test(p))).toEqual([]);
      expect(t.std.find((a) => a[0] === 'VexVoid')?.[2]).toBe('Music & art');
      expect(t.std.map((a) => a[2]).filter((c) => /game/i.test(c))).toEqual([]);
    }
  });
  test('bWalletX build: all of it is as it was', () => {
    const t = textsOf({});
    expect(t.domain).toBe(true);
    expect(t.marketApp).toBe('1sat.market');
    expect(t.history).toBe('1sat.market');
    expect(t.venues).toBe('the Market and 1sat.market');
    expect(t.url).toBe('https://1sat.market/market');
    expect(t.icons).toContain('bExchange');
    expect(t.purposes).toContain('bMail: Tokenised mail, price-to-reach and inbox tips.');
    expect(t.purposes).toContain('bStore: Themes, icons and packs for bWalletX, and their makers.');
    const zero = t.std.find((a) => a[0] === 'Zero Dice');
    expect(zero?.[1]).toBe('Provably fair dice with a zero house edge');
    expect(t.std.find((a) => a[0] === 'VexVoid')?.[2]).toBe('Games & collectibles');
    expect(t.mint).toContain('Prove it, then tokenise it');
    expect(t.mint).toContain('or prove you own a web domain and tokenise it.');
    expect(t.mint).toContain('A name or a domain');
  });
  test('Mint › A domain: the step, its title and both chooser rows are behind DOMAIN_MINT_ENABLED', () => {
    const m = srcOf('./mint/MintButton.tsx');
    expect(m).toMatch(/DOMAIN_MINT_ENABLED && step === 'domain'\s*\? 'Tokenise a domain'/);
    expect(m).toContain("{DOMAIN_MINT_ENABLED && step === 'domain' && CHOICES.has('token') && (");
    expect(m).toMatch(/\.\.\.\(DOMAIN_MINT_ENABLED\s*\? \[\s*\{\s*id: 'domain',/);
    expect(m.match(/Tokenise|tokenise/g)).toHaveLength(2);
    expect(srcOf('./mint/mintCatalog.ts')).toMatch(/\.\.\.\(DOMAIN_MINT_ENABLED\s*\? \[\s*\{\s*id: 'domain',/);
    expect(srcOf('./storeBuild.ts')).toMatch(
      /export const DOMAIN_MINT_ENABLED: boolean = !\(\s*import\.meta\.env\.VITE_STORE_BUILD === '1'/,
    );
  });
  test('the bApp room cards and menu are bWalletX only, so a store user never sees a room purpose', () => {
    expect(srcOf('./tabs/ChatPage.tsx')).toContain("const bappsView = BSPACES_ENABLED && roomFilter === 'bapps';");
    expect(srcOf('./wide/WideShell.tsx')).toMatch(
      /items: BAPP_ROOMS\.map\(\(b\) => \(\{.{0,400}?hidden: !BSPACES_ENABLED,/s,
    );
  });
  test('Home: every module a store build can show has plain wording; the Store showcase is not one of them', async () => {
    const { storeBannedWord } = await import('./storeBuild');
    const h = srcOf('./home/HomeModules.tsx');
    const mods = [
      ...h.matchAll(/id: '(\w+)',\s*title: '([^']*)',\s*blurb: ("[^"]*"|'[^']*'),[^}]*?store: (true|false),/g),
    ];
    expect(mods.length).toBe(9);
    const store = mods.filter((m) => m[4] === 'true');
    expect(store.map((m) => m[1])).toEqual([
      'card',
      'askB',
      'history',
      'priceChart',
      'pots',
      'notifications',
      'holdings',
      'music',
    ]);
    for (const m of store) expect(storeBannedWord(`${m[2]} ${m[3]}`)).toBeNull();
    expect(mods.find((m) => m[1] === 'showcase')?.[4]).toBe('false');
  });
});

describe('every fee to bCorp goes through bcorpFeeAddress, so a store build charges none', () => {
  test('the OpNS per-name service fee: no address in a store build, whatever the env says', async () => {
    const { opnsFeeAddress, serviceFeeUsd } = await import('./names/opnsBatch');
    expect(opnsFeeAddress('1FeeAddress', true)).toBe('');
    expect(opnsFeeAddress('1FeeAddress', false)).toBe('1FeeAddress');
    expect(opnsFeeAddress('', false)).toBe('');
    expect(serviceFeeUsd(3, opnsFeeAddress('1FeeAddress', true))).toBe(0);
    expect(serviceFeeUsd(3, opnsFeeAddress('1FeeAddress', false))).toBe(3);
    expect(srcOf('./names/opnsBatch.ts')).toContain(
      "export const OPNS_FEE_ADDRESS: string = opnsFeeAddress(import.meta.env?.VITE_OPNS_FEE_ADDRESS ?? '');",
    );
  });
  test('the build-time fee addresses (mint, market, sell, room setup) are all read through bcorpFeeAddress', () => {
    expect(srcOf('./mint/mint.ts')).toMatch(/const configured = bcorpFeeAddress\(typeof __MINT_FEE_ADDRESS__/);
    expect(srcOf('./market/fee.ts')).toMatch(/const configured = bcorpFeeAddress\(typeof __MARKET_FEE_ADDRESS__/);
    expect(srcOf('./sell/sell.ts')).toMatch(/const feeAddress = bcorpFeeAddress\(typeof __MARKET_FEE_ADDRESS__/);
    expect(srcOf('./tokens/roomSetup.ts')).toContain('const a = bcorpFeeAddress(address, store);');
    // The only other reader of a fee define: our own service payees, data only behind SUBSCRIPTIONS_ENABLED.
    expect(srcOf('./pots/pots.ts')).toMatch(
      /ownServicePayees = \(\): readonly ServicePayee\[\] =>\s*SUBSCRIPTIONS_ENABLED\s*\?/,
    );
    // No other file reads a *_FEE_ADDRESS define.
    const readers = ['./mint/mint.ts', './market/fee.ts', './sell/sell.ts', './tokens/roomSetup.ts', './pots/pots.ts'];
    for (const f of readers) expect(srcOf(f)).toMatch(/__[A-Z_]+_FEE_ADDRESS__/);
  });
  test('a room charges per message only where token rooms are (not in a store build)', () => {
    const c = srcOf('./tabs/ChatPage.tsx');
    expect(c).toContain('const ROOMS = tokenRoomsEnabled();');
    expect(c).toMatch(/const loadCharge = useCallback\(\(\) => \{\s*if \(!ROOMS \|\| !entryKey\) return;/);
  });
});
