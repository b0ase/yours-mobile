#!/usr/bin/env node
/**
 * Reads a BUILT store bundle and fails if it carries wording the store edition must not ship: exchanges and
 * markets, trading, token sales, launch curves, token rooms, games with stakes, PNEEs offers, priced names.
 * Source-level gates are tested in src/mobile/storeBuild.test.ts; this checks the output, where a missed gate shows.
 *
 *   node scripts/store-bundle-check.mjs [dir]      (default: build-mobile; it must be a store build)
 *   pnpm check:store-bundle                         builds the store bundle first, then runs this
 *   scripts/channel-build.sh ios-store|android-play runs it after the store web build and stops on a failure
 *
 * Two passes, and either one fails the check (exit 1, every hit listed with its file and the text around it):
 *  1. BANNED: exact text (case-sensitive) searched in every text file of the bundle.
 *  2. Words: STORE_BANNED_WORDS (src/mobile/storeBuild.ts, read from the source so there is one list), case-
 *     insensitive, over the UI strings of every JS chunk: JSX children (a split child like ["Set up $",t,"'s room"] is
 *     joined first) and title / sub / label / aria-label / placeholder / description … literals. A hit that has to
 *     stay goes in scripts/store-bundle-allow.json with its reason; an entry without a reason fails the check.
 * Add to BANNED when a gate is added.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact text (case-sensitive) that must not be anywhere in a store bundle. */
export const BANNED = [
  // Markets, exchanges and their tiles
  '1sat.market',
  '1Sat Market',
  'bExchange',
  'Markets & collectibles',
  'Buy BSV',
  'Get PNEEs',
  'Buy MNEE',
  'Brokerless',
  'budz.lol',
  'dxs.app',
  'For sale:',
  'tickets for sale',
  'Buy or sell this token',
  'list them for sale',
  'sell it or give it away',
  'Choose a price between',
  'Search, buy or claim',
  // Catalogue wording
  'real stakes',
  'stake BSV',
  'tradable',
  'tokenised films',
  'Tokenise',
  'tokenise it',
  'for every token',
  'Provably fair',
  'Zero Dice',
  'earn your belts',
  'Own & trade',
  // Launch curves and example strategies
  'if all sell',
  'Fair launch',
  '$100M',
  'permanent once you launch',
  'all on the curve',
  'launch curve (MAP)',
  'Launch your tokens',
  'in $5 steps',
  'never buys above',
  // Token rooms and the paid room set-up
  'Open its room',
  'Set up your token room',
  'opens its chat room',
  'room to list it in other wallets',
  'Set up its room (Settings',
  'Token room',
  'first 1,000 rooms',
  // Games
  'Play games',
  'Midnight Pass',
  'bitcoin-gaming.vercel.app',
  'arcade/terrornode',
  // PNEEs offers (a holder's balance row stays: "PNEEs · USD¢")
  'to back PNEEs',
  'paid in PNEE',
  'PNEE payments can',
  // The b agent must not describe a Market in this edition
  'Market: browse NFTs',
  // Text of buttons and sheets a store build never shows
  'from players',
  'load strategies',
  'On the Exchange',
  'PNEEs pot',
  'not token rooms',
  // A1 (17 Nov review): Settings › Identity's personal token + room
  'and open my room',
  'Invite = send 1',
  '+ your $',
  'token + room',
  // A2: the b agent's guide (store bar, tickets, token and personal rooms)
  'Apps · Market ·',
  'Chat: token rooms',
  'mints a ticket token',
  'opens your personal room',
  'Tickets and personal tokens',
  // A5, A6: selling names
  'Selling works for names',
  'tap to sell or give',
  'For sale',
  'On sale ·',
];

const TEXT = /\.(js|mjs|css|html|json|webmanifest|txt|svg)$/;
const HERE = dirname(fileURLToPath(import.meta.url));

/** STORE_BANNED_WORDS, read from src/mobile/storeBuild.ts (a TS module with import.meta.env, so not imported here). */
export const storeBannedWords = (src = readFileSync(join(HERE, '../src/mobile/storeBuild.ts'), 'utf8')) => {
  const m = /export const STORE_BANNED_WORDS: RegExp =\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*);/.exec(src);
  if (!m) throw new Error('store-bundle-check: STORE_BANNED_WORDS not found in src/mobile/storeBuild.ts');
  return new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`);
};

const STR = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60`;
const UI_KEYS = String.raw`children|title|sub|subtitle|label|"aria-label"|placeholder|description|desc|text|body|hint|note|cta|heading|caption|blurb|tagline|message|alt|summary|detail|intro|empty`;
const UI_PROP = new RegExp(String.raw`(?:^|[{,\s])(?:${UI_KEYS}):\s*(${STR})`, 'g');

/**
 * The UI strings in a minified JS chunk: UI_KEYS literals, and the direct string children of every children:[…]
 * array joined with " … " (a split child like ["Set up $",t,"'s room"]; nested elements are read on their own).
 */
export const uiStrings = (js) => {
  const out = [];
  for (const m of js.matchAll(UI_PROP)) out.push(m[1].slice(1, -1));
  const lit = new RegExp(STR, 'g');
  for (const m of js.matchAll(/children:\[/g)) {
    const parts = [];
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < js.length && depth > 0 && i - start < 4000) {
      const c = js[i];
      if (c === '"' || c === "'" || c === '`') {
        lit.lastIndex = i;
        const l = lit.exec(js);
        if (l && l.index === i) {
          if (depth === 1) parts.push(l[0].slice(1, -1));
          i += l[0].length;
          continue;
        }
      }
      if (c === '[' || c === '(' || c === '{') depth++;
      else if (c === ']' || c === ')' || c === '}') depth--;
      i++;
    }
    if (parts.length) out.push(parts.join(' … '));
  }
  return out.filter((s) => /[A-Za-z]{2}/.test(s));
};

/** "LockScreen-CupG8rPu.js" → "LockScreen" (Vite's 8-character hash dropped). */
export const chunkName = (file) => basename(file).replace(/-[\w-]{8}\.[a-z]+$/, '');

/**
 * scripts/store-bundle-allow.json: [{ chunk, match | pattern, reason }]. `match` is a case-sensitive substring of the
 * UI string, `pattern` a regex for it (for a short word whose minified variable names change). Throws if an entry
 * has no chunk, neither match nor pattern, or no reason.
 */
export const loadAllow = (path = join(HERE, 'store-bundle-allow.json')) => {
  const list = JSON.parse(readFileSync(path, 'utf8')).allow;
  for (const a of list)
    if (!a.chunk || !(a.match || a.pattern) || typeof a.reason !== 'string' || a.reason.trim().length < 10)
      throw new Error(
        `store-bundle-check: allowlist entry ${JSON.stringify(a)} needs chunk, match or pattern, and a reason`,
      );
  // Matched against the string with its whitespace runs folded to one space, as the check prints it.
  const fold = (s) => s.replace(/\s+/g, ' ');
  return list.map((a) => {
    const re = a.pattern ? new RegExp(a.pattern) : null;
    return { ...a, test: (s) => (re ? re.test(fold(s)) : fold(s).includes(a.match)) };
  });
};

/** Pass 2: banned words in the UI strings of every JS chunk, less the allowlist. Returns { hits, unused }. */
export const scanWords = (dir, words = storeBannedWords(), allow = loadAllow()) => {
  const hits = [];
  const used = new Set();
  const re = new RegExp(
    words.source,
    words.flags.replace('g', '').includes('i') ? words.flags.replace('g', '') : `${words.flags.replace('g', '')}i`,
  );
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.m?js$/.test(name)) {
        const chunk = chunkName(name);
        for (const s of uiStrings(readFileSync(p, 'utf8'))) {
          const w = re.exec(s);
          if (!w) continue;
          const ok = allow.findIndex((a) => (a.chunk === '*' || a.chunk === chunk) && a.test(s));
          if (ok >= 0) {
            used.add(ok);
            continue;
          }
          hits.push({ file: relative(dir, p), text: w[0], around: s.slice(0, 160).replace(/\s+/g, ' ') });
        }
      }
    }
  };
  walk(dir);
  return { hits, unused: allow.filter((_, i) => !used.has(i)) };
};

export const scan = (dir, banned = BANNED) => {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.test(name)) {
        const text = readFileSync(p, 'utf8');
        for (const b of banned) {
          const i = text.indexOf(b);
          if (i < 0) continue;
          hits.push({
            file: relative(dir, p),
            text: b,
            around: text.slice(Math.max(0, i - 60), i + b.length + 60).replace(/\s+/g, ' '),
          });
        }
      }
    }
  };
  walk(dir);
  return hits;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'build-mobile';
  const hits = scan(dir);
  const words = scanWords(dir);
  if (hits.length) {
    console.error(`store-bundle-check: ${hits.length} banned string(s) in ${dir}:`);
    for (const h of hits) console.error(`  ${h.file}: "${h.text}" … ${h.around}`);
  }
  if (words.hits.length) {
    console.error(`store-bundle-check: ${words.hits.length} UI string(s) with a banned word in ${dir}:`);
    for (const h of words.hits) console.error(`  ${h.file}: [${h.text}] ${h.around}`);
  }
  if (hits.length || words.hits.length) process.exit(1);
  if (words.unused.length)
    console.log(
      `store-bundle-check: ${words.unused.length} allowlist entr${words.unused.length === 1 ? 'y' : 'ies'} matched nothing (stale?): ` +
        words.unused.map((a) => `${a.chunk}: ${a.match ?? a.pattern}`).join('; '),
    );
  console.log(
    `store-bundle-check: ${dir} is clean (${BANNED.length} strings; banned words in UI strings, with the allowlist)`,
  );
}
