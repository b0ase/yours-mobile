import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error plain .mjs script, no type declarations
import {
  BANNED,
  isMain,
  loadAllow,
  scanWords,
  storeBannedWords,
  uiStrings,
} from '../../scripts/store-bundle-check.mjs';

/**
 * Round A8 (CTO decisions, 16 Nov 2026, review S1-S7): store build only. Every wording test runs the three store envs
 * and bWalletX in child processes (the literal flags are read at import), and checks bWalletX word for word.
 */
const STORE_ENVS = [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }];
const ROOT = new URL('../..', import.meta.url).pathname;
const srcOf = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const run = <T>(code: string, env: Record<string, string>): T => {
  const r = Bun.spawnSync(['bun', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
  });
  const out = r.stdout.toString().trim().split('\n').pop() ?? '';
  if (!out) throw new Error(r.stderr.toString());
  return JSON.parse(out) as T;
};
const allowEntries = () =>
  (
    JSON.parse(readFileSync(join(ROOT, 'scripts/store-bundle-allow.json'), 'utf8')) as {
      allow: { chunk: string; match?: string; pattern?: string; reason: string }[];
    }
  ).allow;

describe('S1: the token market-sales chart is bWalletX only', () => {
  test('SendBsv21View loads TokenPriceChart only behind the literal MARKET_ENABLED, so a store build drops the chunk', () => {
    const s = srcOf('../components/SendBsv21View.tsx');
    expect(s).toContain(
      "const TokenPriceChart = MARKET_ENABLED\n  ? lazy(() => import('../mobile/wallet/TokenPriceChart').then((m) => ({ default: m.TokenPriceChart })))\n  : null;",
    );
    expect(s).toContain('{MARKET_ENABLED && TokenPriceChart && (');
    expect(s).toContain('<TokenPriceChart tokenId={token.info.id} />');
    expect(s).not.toContain('wallet/PriceChart');
    // vite.config.mobile.ts inserts TokenLinks (both editions) before this anchor, outside the gate.
    expect(s).toContain('          {/* Market chart */}\n');
  });
  test('the sales chart lives in its own module; the shared PriceChart module keeps only the BSV chart', () => {
    const shared = srcOf('./wallet/PriceChart.tsx');
    expect(shared).not.toMatch(/tokenSales|No market sales|sales`/);
    expect(shared).toContain('export const BsvPriceChart = () => {');
    const token = srcOf('./wallet/TokenPriceChart.tsx');
    expect(token).toContain('export const TokenPriceChart = ({ tokenId }: { tokenId: string }) => {');
    // bWalletX's words are unchanged.
    for (const w of [
      'No market sales yet.',
      'unit="per token"',
      'note={`${ys.length} sales`}',
      'No sales in this range.',
    ])
      expect(token).toContain(w);
  });
  test('the false allowlist entry is gone and the chart wording is banned', () => {
    expect(allowEntries().filter((a) => a.chunk === 'PriceChart' || a.match === 'No market sales yet')).toEqual([]);
    for (const s of ['No market sales yet', 'No sales in this range', ' sales`']) expect(BANNED).toContain(s);
  });
});

describe('S2: Ask b offers no room or bounty ideas, and lists no Market or Tickets screen, in a store build', () => {
  const code = `const i = await import('./src/mobile/agent/ideas.ts'); const a = await import('./src/mobile/agent/inlineActions.ts');
    console.log(JSON.stringify({ chat: i.IDEAS.filter((x) => x.topic === 'Chat').map((x) => x.label), screens: a.SAFE_SCREENS,
      prompt: a.INLINE_ACTIONS_PROMPT, market: a.safeTarget('/m/market'), tickets: a.safeTarget('/m/tickets'), nfts: a.safeTarget('/m/nfts') }));`;
  type R = {
    chat: string[];
    screens: string[];
    prompt: string;
    market: string | null;
    tickets: string | null;
    nfts: string;
  };
  const ROOM_IDEAS = [
    'Invite a friend to your room',
    'Open my personal room',
    'Why did a room disappear?',
    'Post a bounty in a room',
  ];
  const X_PROMPT = [
    '\n\nBUTTONS: when a reply points to a screen the person can open next, add up to 3 buttons on their own line,',
    'written exactly as [[Label|/m/screen]] (a short label, 1–4 words). Only these screens:',
    '/m/home, /m/chat (or /m/chat?room=TICKER for a room), /m/feed, /m/settings, /m/tickets, /m/names, /m/nfts,',
    '/m/market, /m/apps, /m/you. A button only opens the screen; it never sends, pays or signs, so never',
    'promise that it will. Never put a full https:// address in a button. Add them only when there is a clear next step.',
  ].join(' ');
  test('store: no room or bounty chips; b is never told about /m/market or /m/tickets, and cannot open them', () => {
    for (const env of STORE_ENVS) {
      const r = run<R>(code, env);
      for (const s of ROOM_IDEAS) expect(r.chat).not.toContain(s);
      expect(r.chat).toContain('Start a call in a room');
      expect(r.screens).not.toContain('market');
      expect(r.screens).not.toContain('tickets');
      expect(r.prompt).not.toMatch(/\/m\/market|\/m\/tickets/);
      expect(r.prompt).toContain('/m/settings, /m/names, /m/nfts, /m/apps, /m/you. A button only opens the screen');
      expect([r.market, r.tickets, r.nfts]).toEqual([null, null, '/m/nfts']);
    }
  }, 60_000);
  test('bWalletX: the chips, their order, the screen list and the prompt are unchanged', () => {
    const r = run<R>(code, {});
    expect(r.chat.slice(0, 5)).toEqual([
      'Invite a friend to your room',
      'Open my personal room',
      'Why did a room disappear?',
      'Start a call in a room',
      'Post a bounty in a room',
    ]);
    expect(r.screens.slice(0, 11)).toEqual([
      'home',
      'chat',
      'feed',
      'settings',
      'ask-b',
      'tickets',
      'names',
      'my-names',
      'nfts',
      'market',
      'apps',
    ]);
    expect(r.prompt).toBe(X_PROMPT);
    expect([r.market, r.tickets]).toEqual(['/m/market', '/m/tickets']);
  }, 60_000);
  test('the ideas and the button list are banned in a store bundle', () => {
    for (const s of [...ROOM_IDEAS, '/m/market,', '/m/tickets,']) expect(BANNED).toContain(s);
  });
});

describe('S3: a listing made elsewhere reads "Listed elsewhere" in a store build (bRadio, NFT burn)', () => {
  const code = `const p = await import('./src/mobile/bradio/podcasts.ts'); const b = await import('./src/mobile/media/nftBurn.ts');
    console.log(JSON.stringify({ note: p.PODCAST_LISTED_NOTE, err: new p.PodcastListedError().message,
      burn: b.burnAvailability({ onChain: true, listed: true, locked: false }).reason }));`;
  test('store wording', () => {
    for (const env of STORE_ENVS)
      expect(run(code, env)).toEqual({
        note: 'Listed elsewhere — cancel that listing in the app where you listed it to play in full',
        err: 'Listed elsewhere — cancel that listing in the app where you listed it to play in full',
        burn: 'Listed elsewhere. Cancel that listing before burning.',
      });
  }, 60_000);
  test('bWalletX wording is unchanged', () => {
    expect(run(code, {})).toEqual({
      note: 'Listed for sale — cancel the listing to play in full',
      err: 'Listed for sale — cancel the listing to play in full',
      burn: 'Listed for sale. Cancel the listing before burning.',
    });
  }, 60_000);
  test('PodcastCard shows the same note; "Listed for sale" is banned', () => {
    expect(srcOf('./bradio/PodcastCard.tsx')).toContain("if (r === 'listed') setNote(PODCAST_LISTED_NOTE);");
    expect(BANNED).toContain('Listed for sale');
  });
});

describe('S4: the checker runs when executed through a symlink or a path with a space or %, and callers need "is clean"', () => {
  const realScript = join(ROOT, 'scripts/store-bundle-check.mjs');
  test('isMain compares real paths as file URLs', () => {
    const d = mkdtempSync(join(tmpdir(), 'a8 main %20 '));
    const link = join(d, 'check link.mjs');
    symlinkSync(realScript, link);
    const url = new URL(`file://${realScript}`).href;
    expect(isMain(url, link)).toBe(true);
    expect(isMain(url, realScript)).toBe(true);
    expect(isMain(url, join(d, 'missing.mjs'))).toBe(false);
    expect(isMain(url, undefined)).toBe(false);
  });
  test('run through a symlink in a folder with a space and %: a dirty bundle fails, a clean one says "is clean"', () => {
    const d = mkdtempSync(join(tmpdir(), 'a8 link %25 '));
    const link = join(d, 'store-bundle-check.mjs');
    symlinkSync(realScript, link);
    const bundle = (js: string) => {
      const b = mkdtempSync(join(tmpdir(), 'a8-bundle-'));
      mkdirSync(join(b, 'assets'));
      writeFileSync(join(b, 'assets/Page-abcdefgh.js'), js);
      return b;
    };
    const dirty = Bun.spawnSync(['node', link, bundle('x={title:"No market sales yet."}')]);
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stderr.toString()).toContain('No market sales yet');
    const clean = Bun.spawnSync(['node', link, bundle('x={title:"Send BSV"}')]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout.toString()).toContain(' is clean (');
  });
  test('channel-build.sh needs exit 0 and the "is clean" line; package scripts check every store bundle path', () => {
    const sh = readFileSync(join(ROOT, 'scripts/channel-build.sh'), 'utf8');
    expect(sh).toContain('  if ! check_out=$(node scripts/store-bundle-check.mjs build-mobile); then\n');
    expect(sh).toContain(`  if ! grep -q '^store-bundle-check: build-mobile is clean ' <<<"$check_out"; then\n`);
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts['check:store-bundle:built']).toBe(
      "node scripts/store-bundle-check.mjs build-mobile | tee /dev/stderr | grep -q 'build-mobile is clean'",
    );
    expect(scripts['cap:sync:store']).toBe('pnpm build:mobile:store && pnpm check:store-bundle:built && cap sync');
    // ios:store and android:store build through cap:sync:store, so the check runs before Xcode / Android Studio open.
    expect(scripts['ios:store']).toBe('pnpm cap:sync:store && cap open ios');
    expect(scripts['android:store']).toBe('pnpm cap:sync:store && cap open android');
    expect(scripts['check:store-bundle']).toBe('VITE_STORE_BUILD=1 pnpm build:mobile && pnpm check:store-bundle:built');
    // bWalletX scripts are unchanged: no check.
    expect(scripts['cap:sync']).toBe('pnpm build:mobile && cap sync');
  });
  test('check:store-bundle:built fails when the checker prints no "is clean" line', () => {
    const cmd = (out: string, code: number) =>
      Bun.spawnSync(['sh', '-c', `(echo "${out}"; exit ${code}) | tee /dev/stderr | grep -q 'build-mobile is clean'`])
        .exitCode;
    expect(cmd('store-bundle-check: build-mobile is clean (1 strings)', 0)).toBe(0);
    expect(cmd('', 0)).toBe(1);
    expect(cmd('', 1)).toBe(1);
  });
});

describe('S5: pass 2 reads error messages, setter arguments, reason fields and ternary branches', () => {
  test('uiStrings finds them in minified code; ids and class names are not read', () => {
    const js =
      'a=new Error("Listed for sale. Cancel the listing before burning."),class X extends Error{constructor(){super("Listed for sale — cancel")}}' +
      ',n(`${e} is on sale for ${t}. Buyers pay you directly`),setMsg("You can sell it now"),q("noSpace"),r=f?"What they sell":"Set up"' +
      ',o={reason:"Listed for sale. Cancel"},p=k?"flex gap-2":"hidden"';
    const got = uiStrings(js) as string[];
    for (const s of [
      'Listed for sale. Cancel the listing before burning.',
      'Listed for sale — cancel',
      '${e} is on sale for ${t}. Buyers pay you directly',
      'You can sell it now',
      'What they sell',
      'Set up',
      'Listed for sale. Cancel',
    ])
      expect(got).toContain(s);
    expect(got).not.toContain('noSpace');
  });
  test('the S3 and S5 bWalletX originals are hits in a bundle; allowlisted library text is not', () => {
    const d = mkdtempSync(join(tmpdir(), 'a8-words-'));
    mkdirSync(join(d, 'assets'));
    writeFileSync(
      join(d, 'assets/OpnsNameActions-abcdefgh.js'),
      'b(`${e} is in your Names now. You can link your identity key or sell it.`);c=u?"Listed for sale. Cancel the listing before burning.":null',
    );
    writeFileSync(
      join(d, 'assets/index-abcdefgh.js'),
      'throw new Error(`Output at index ${e} does not exist`);x(`Fiat exchange-rate URL is invalid`)',
    );
    const r = scanWords(d, storeBannedWords(), loadAllow()) as { hits: { file: string; around: string }[] };
    expect(r.hits.map((h) => h.around).sort()).toEqual([
      '${e} is in your Names now. You can link your identity key or sell it.',
      'Listed for sale. Cancel the listing before burning.',
    ]);
  });
  test('every new allowlist entry states its gate or why it is a false positive', () => {
    const by = (chunk: string, key: string) =>
      allowEntries().find((a) => a.chunk === chunk && (a.match === key || a.pattern === key));
    const NEW: [string, string, RegExp][] = [
      ['*', '\\bindex \\$\\{', /^False positive/],
      ['*', '[Ee]xchange-?[Rr]ates?|exchangerate', /^False positive/],
      ['*', 'hosts are backing off', /^False positive/],
      ['*', 'Cannot buy BSV-20 token listing through ordinal purchase', /^Library text/],
      ['*', '^OrdLockV2[:.]', /^Library text/],
      ['index', '[Pp]ayouts?\\b', /^Reviewed and allowed/],
      ['index', '^Backing [Uu]p', /^False positive/],
      ['index', 'token airdrop', /^Reviewed and allowed/],
      ['BsvWallet', 'Play to earn more', /^Not shown in a store build/],
      ['LockScreen', 'Backing ${', /ARTIST_PROGRAMME_ENABLED/],
    ];
    for (const [chunk, key, reason] of NEW) expect(by(chunk, key)?.reason ?? `missing ${chunk} ${key}`).toMatch(reason);
    const unreachable = allowEntries().filter((a) => a.chunk === 'background' || a.chunk === 'prompt-tab');
    expect(
      unreachable.filter((a) => /swap/i.test(a.reason) && /handleSiteCall/.test(a.reason)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(unreachable.some((a) => /permission-module enrichIntent/.test(a.reason))).toBe(true);
  });
  const code = `const c = await import('./src/mobile/wallet/bcalDays.ts'); const p = await import('./src/mobile/locks/pots.ts');
    const g = await import('./src/mobile/chat/roomGate.ts');
    const row = (type) => ({ txid: 'ab', time: 0, type, amountSats: -5, asset: null, label: 'Frog #1' });
    console.log(JSON.stringify({ cal: c.tradeItems([row('buy'), row('sell')]).map((x) => x.title), pot: p.potName('artist:vexvoid'),
      gate: g.lockedLine({ key: 'k', symbol: 'TN', dec: 0, minRaw: '1' }, true) }));`;
  test('store wording: bCal "Listing ended", artist pot "Locked for", no "Play to earn" line', () => {
    for (const env of STORE_ENVS)
      expect(run(code, env)).toEqual({
        cal: ['Bought Frog #1', 'Listing ended: Frog #1'],
        pot: 'Locked for vexvoid',
        gate: 'Hold 1 $TN to join',
      });
  }, 60_000);
  test('bWalletX wording is unchanged', () => {
    expect(run(code, {})).toEqual({
      cal: ['Bought Frog #1', 'Sold Frog #1'],
      pot: 'Backing vexvoid',
      gate: 'Hold 1 $TN to join · Play to earn',
    });
  }, 60_000);
  test('the other S5 strings pick their words with a literal flag, outside try blocks so Rollup folds them', () => {
    const o = srcOf('./names/OpnsNameActions.tsx');
    expect(o).toContain(
      "const ADOPTED_NEXT = MARKET_ENABLED ? 'You can link your identity key or sell it.' : 'You can link your identity key.';",
    );
    expect(o).toContain('setMsg(`${name} is in your Names now. ${ADOPTED_NEXT}`);');
    expect(o).toMatch(
      /\? MARKET_ENABLED\s*\? 'This name came in with your NFTs\. Add it to your Names list first, then link it and sell it\. Adding is free: no transaction, nothing sent\.'\s*: 'This name came in with your NFTs\. Add it to your Names list first, then link it\. Adding is free: no transaction, nothing sent\.'/,
    );
    expect(srcOf('./chat/BusinessAgentViews.tsx')).toMatch(
      /\? MARKET_ENABLED\s*\? 'What they sell'\s*: 'What they offer'/,
    );
    expect(srcOf('./names/store/NameStorePage.tsx')).toMatch(
      /if \(MARKET_ENABLED\)\s*setMsg\(`\$\{n\} is on sale for \$\{fmtUsd\(usd\)\}\. Buyers pay you directly; take it off sale any time\.`\);/,
    );
    expect(srcOf('./bradio/PodcastCard.tsx')).toContain('{MARKET_ENABLED && onBuy && !mine && (');
    for (const s of [
      'link it and sell it',
      'identity key or sell it',
      'What they sell',
      'is on sale for',
      ' · Play to earn',
    ])
      expect(BANNED).toContain(s);
  });
});

describe('S6: allowlist reasons for the agent trading text name the real gate', () => {
  test('the sessions entries cite CLI pairing, CliPairConfirm and the agentPairing refusal', () => {
    const s = allowEntries().filter((a) => a.chunk === 'sessions');
    expect(s.length).toBeGreaterThanOrEqual(4);
    for (const a of s) {
      expect(a.reason).not.toContain('AgentConversation runs actions only when MARKET_ENABLED');
      expect(a.reason).toMatch(/agentPairing refuses/);
    }
    for (const m of ['Selling from chat', 'Paper buy', 'Buy failed'])
      expect(s.find((a) => a.match === m)?.reason).toContain('CliPairConfirm offers no trade scope');
  });
});
