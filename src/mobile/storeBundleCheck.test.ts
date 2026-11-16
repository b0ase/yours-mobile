import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { STORE_BANNED_WORDS } from './storeBuild';
// @ts-expect-error plain .mjs script, no type declarations
import {
  BANNED,
  chunkName,
  loadAllow,
  scan,
  scanWords,
  storeBannedWords,
  uiStrings,
} from '../../scripts/store-bundle-check.mjs';

/**
 * scripts/store-bundle-check.mjs reads a BUILT store bundle for wording the store edition must not ship. It runs in
 * scripts/channel-build.sh after the web build of every store channel (ios-store, android-play) and stops the
 * release on a hit; `pnpm check:store-bundle` builds a store bundle and runs it by hand. These tests cover the
 * checker itself. The last one reads a built store bundle only when STORE_BUNDLE_DIR points at one (nothing sets it
 * automatically; no CI job builds the store edition).
 */
describe('store bundle check', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'store-bundle-'));
    mkdirSync(join(d, 'assets'));
    return d;
  };
  test('finds banned text in any text asset, with the file and the text around it', () => {
    const d = dir();
    writeFileSync(join(d, 'assets/BsvWallet-abc.js'), 'const a="Set up your token room";const b="fine";');
    writeFileSync(join(d, 'assets/Mint-abc.js'), 'x={sub:"Search, buy or claim one. From $1"}');
    writeFileSync(join(d, 'index.html'), '<a href="https://1sat.market/">m</a>');
    writeFileSync(join(d, 'assets/song.mp3'), 'Buy BSV'); // not a text asset: ignored
    const hits = scan(d) as { file: string; text: string; around: string }[];
    expect(hits.map((h) => `${h.file}: ${h.text}`).sort()).toEqual([
      'assets/BsvWallet-abc.js: Set up your token room',
      'assets/Mint-abc.js: Search, buy or claim',
      'index.html: 1sat.market',
    ]);
    expect(hits.find((h) => h.file === 'index.html')?.around).toContain('href="https://1sat.market/"');
  });
  test('a clean bundle has no hits; what a holder still needs is not on the list', () => {
    const d = dir();
    writeFileSync(
      join(d, 'assets/a.js'),
      'ticker:"PNEEs · USD¢";t="Send your token";u="Not available in this edition"',
    );
    expect(scan(d)).toEqual([]);
    expect(BANNED).not.toContain('PNEEs');
  });
  test('the list covers every finding of the 16 Nov review', () => {
    for (const s of [
      'Set up your token room',
      'opens its chat room',
      'For sale:',
      'Search, buy or claim',
      'list them for sale',
      'sell it or give it away',
      'Set up its room (Settings',
      'tickets for sale',
      'Buy or sell this token',
      'Launch your tokens',
      'arcade/terrornode',
      'Market: browse NFTs',
      'to back PNEEs',
      'launch curve (MAP)',
      'Token room',
      '1sat.market',
      'bExchange',
      'real stakes',
      'Fair launch',
    ])
      expect(BANNED).toContain(s);
  });
  test('the list covers the A1, A2, A5, A6 and A8 findings of the second 16 Nov review', () => {
    for (const s of [
      'and open my room',
      'Invite = send 1',
      '+ your $',
      'token + room',
      'Apps · Market ·',
      'Chat: token rooms',
      'mints a ticket token',
      'opens your personal room',
      'Selling works for names',
      'tap to sell or give',
      'For sale',
      'On sale ·',
      // A8: paid indexing
      'Index $$',
      'Index ·',
      'Index your token',
      'Token indexing',
      'Indexed by 1Sat',
    ])
      expect(BANNED).toContain(s);
    // A bare 'Index $' would hit minified code (`outputIndex ${i}`).
    expect(BANNED).not.toContain('Index $');
    // A9: the investor placeholders, in both passes, and never allowlisted.
    expect(BANNED).toContain('LEGAL REVIEW');
    expect(BANNED).toContain('Placeholder for the FPO');
    const w = storeBannedWords() as RegExp;
    expect(w.test('[LEGAL REVIEW] Statement wording is pending legal review.')).toBe(true);
    expect(w.test('[legal review] Placeholder for the FPO art. 48 high net worth statement')).toBe(true);
  });
  test('the list covers the bWalletX wording of the A7 decisions (16 Nov), so a store build cannot carry it', () => {
    for (const s of [
      'Reward, e.g.',
      'lock the reward',
      'back this post',
      'Locking backs a post',
      'send it or sell it',
      'you buy or mint live here',
      'Listed for sale on RelayX',
      'listed for sale on RelayX',
      'Your listing sold',
      'When a listing of yours sells',
      'listing cancelled',
      'Exchange search',
      'strategies on the Exchange',
      'Trading and sending need',
      'offer to sell them for you',
      'rooms and swaps work',
    ])
      expect(BANNED).toContain(s);
  });
  const built = process.env.STORE_BUNDLE_DIR;
  test.skipIf(!built || !existsSync(built ?? ''))('the built store bundle in STORE_BUNDLE_DIR is clean', () => {
    expect(scan(built)).toEqual([]);
    expect(scanWords(built).hits).toEqual([]);
  });
});

describe('store bundle check, pass 2: banned words in UI strings', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'store-words-'));
    mkdirSync(join(d, 'assets'));
    return d;
  };
  const allowFile = (allow: unknown[]) => {
    const f = join(mkdtempSync(join(tmpdir(), 'store-allow-')), 'allow.json');
    writeFileSync(f, JSON.stringify({ allow }));
    return f;
  };
  test('the word list is STORE_BANNED_WORDS itself, read from storeBuild.ts, case-insensitive', () => {
    const w = storeBannedWords() as RegExp;
    expect(w.source).toBe(STORE_BANNED_WORDS.source);
    expect(w.flags).toContain('i');
    expect(w.test('FOR SALE')).toBe(true);
    expect(w.test('Open my room')).toBe(true);
    expect(w.test('Invite = send 1 $X')).toBe(true);
  });
  test('uiStrings: UI props, and a split JSX child joined; nested elements read on their own', () => {
    const js =
      'a=u.jsxs("p",{children:["Set up $",t,"\'s room"]}),b={title:"Sell it",x:"code-only text here"},' +
      'c={"aria-label":`For sale ${x}`},d=u.jsxs("div",{className:"flex gap-2",children:["Hi ",u.jsx("b",{children:"Trade now"})]})';
    expect((uiStrings(js) as string[]).sort()).toEqual(
      ['For sale ${x}', 'Hi ', "Set up $ … 's room", 'Sell it', 'Trade now'].sort(),
    );
  });
  test("chunkName drops Vite's 8-character hash", () => {
    expect(chunkName('assets/BsvWallet-BceF-KNF.js')).toBe('BsvWallet');
    expect(chunkName('index.client-SVv493s2.js')).toBe('index.client');
    expect(chunkName('NameStorePage-Duv-n8CD.js')).toBe('NameStorePage');
  });
  test('scanWords: any case is a hit; the allowlist lets through only its chunk and text, and reports unused entries', () => {
    const d = dir();
    writeFileSync(join(d, 'assets/LockScreen-abcdefgh.js'), 'x={label:"BSV per payout"},y={title:"FOR SALE now"}');
    writeFileSync(join(d, 'assets/Other-abcdefgh.js'), 'x={label:"BSV per payout"},z={sub:"Lock   next payouts"}');
    const allow = loadAllow(
      allowFile([
        { chunk: 'LockScreen', match: 'payout', reason: 'the user’s own locked BSV paid back to them' },
        { chunk: 'Other', pattern: '^Lock next payouts$', reason: 'folded whitespace, regex form' },
        { chunk: 'Nowhere', match: 'nothing', reason: 'an entry nothing matches' },
      ]),
    );
    const r = scanWords(d, storeBannedWords(), allow) as {
      hits: { file: string; text: string }[];
      unused: { chunk: string }[];
    };
    expect(r.hits.map((h) => `${h.file}: ${h.text}`).sort()).toEqual([
      'assets/LockScreen-abcdefgh.js: FOR SALE',
      'assets/Other-abcdefgh.js: payout',
    ]);
    expect(r.unused.map((a) => a.chunk)).toEqual(['Nowhere']);
  });
  test('an allowlist entry without a reason, or without match / pattern, stops the check', () => {
    expect(() => loadAllow(allowFile([{ chunk: 'X', match: 'sell' }]))).toThrow(/reason/);
    expect(() => loadAllow(allowFile([{ chunk: 'X', match: 'sell', reason: 'short' }]))).toThrow(/reason/);
    expect(() => loadAllow(allowFile([{ chunk: 'X', reason: 'a long enough reason' }]))).toThrow(/match or pattern/);
  });
  test('the real allowlist loads: every entry has a chunk, a match or pattern and a reason', () => {
    const list = loadAllow() as { chunk: string; reason: string }[];
    expect(list.length).toBeGreaterThan(20);
    for (const a of list) expect(a.reason.trim().length).toBeGreaterThanOrEqual(10);
    // Nothing the A1/A2/A5/A6 findings removed is allowlisted back in.
    const allowed = (
      JSON.parse(readFileSync(new URL('../../scripts/store-bundle-allow.json', import.meta.url), 'utf8')) as {
        allow: { match?: string; pattern?: string }[];
      }
    ).allow.map((a) => `${a.match ?? ''} ${a.pattern ?? ''}`);
    for (const s of [
      'open my room',
      'Invite = send',
      'token room',
      'Selling works',
      'tap to sell',
      'On sale',
      'LEGAL',
      'FPO',
    ])
      expect(allowed.filter((a) => a.includes(s))).toEqual([]);
  });
  test('channel-build.sh runs the check right after the store web build and stops the release on a failure', () => {
    const sh = readFileSync(new URL('../../scripts/channel-build.sh', import.meta.url), 'utf8');
    const build = 'VITE_CHANNEL=$CH VITE_STORE_BUILD=${STORE:+1} pnpm build:mobile >/dev/null\n';
    const check = [
      'if [[ -n $STORE ]]; then',
      '  echo "▸ store bundle check"',
      '  if ! node scripts/store-bundle-check.mjs build-mobile; then',
      '    echo "    ✗ store bundle check failed: $CH not built (fix the gate, or allowlist with a reason)" >&2',
      '    exit 1',
      '  fi',
      'fi',
      'pnpm exec cap sync >/dev/null',
    ].join('\n');
    const at = sh.indexOf(build);
    expect(at).toBeGreaterThan(0);
    // Only comment lines between the web build and the check; the check comes before cap sync.
    const after = sh.slice(at + build.length);
    expect(after.startsWith(check) || /^(?:#[^\n]*\n)+/.exec(after)?.[0].length === after.indexOf(check)).toBe(true);
    // Store channels set STORE; the bWalletX channels leave it empty, so their build is not checked.
    expect(sh).toContain('ios-store | android-play) STORE=1 ;;');
    expect(sh).toContain('ios-private | android-direct) STORE= ;;');
  });
});
