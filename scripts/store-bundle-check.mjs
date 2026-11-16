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
 *     joined first), title / sub / label / aria-label / placeholder / description / reason / error … literals, and
 *     sentence-like error messages (new X("…"), super("…")), setter arguments (setMsg("…")) and ternary branches.
 *     A hit that has to stay goes in scripts/store-bundle-allow.json with its reason; an entry without a reason
 *     fails the check.
 * Add to BANNED when a gate is added.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exact text (case-sensitive) that must not be anywhere in a store bundle. */
export const BANNED = [
  // Investor self-certification placeholders (A9: hidden in every edition, 16 Nov 2026).
  'LEGAL REVIEW',
  'Placeholder for the FPO',
  'Qualify as an investor',
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
  // A8 (owner, 16 Nov 2026): no paid indexing in a store build. ('Index $$' = the template "Index $${ticker}";
  // a bare 'Index $' would match code such as `outputIndex ${i}`. 'indexing fee' alone is in history labels and
  // payment checks, so pass 2's word list covers it in UI strings instead.)
  'Index $$',
  'Index ·',
  'Index your token',
  'so other wallets can see',
  'Indexing lets other wallets see',
  'Indexing a token lets other wallets see',
  "tokens' indexing fee",
  'Token indexing',
  'One-tap indexing',
  'Indexed by 1Sat',
  'prepaid deposit with the 1Sat',
  // A7 (CTO decisions, 16 Nov 2026): the bWalletX wording of the A6 follow-ups, which a store build words differently
  // or leaves out.
  'Reward, e.g.',
  'lock the reward',
  'back this post',
  'Locking backs a post',
  'send it or sell it',
  'you buy or mint live here',
  'isn’t for sale and',
  'Listed for sale on RelayX',
  'listed for sale on RelayX',
  'Your listing sold',
  'A buyer took your listing',
  'When a listing of yours sells',
  'listing cancelled',
  'Exchange search',
  'strategies on the Exchange',
  'Trading and sending need',
  'offer to sell them for you',
  'rooms and swaps work',
  // A8 (CTO decisions, 16 Nov 2026). S1: the token page's market-sales chart (wallet/TokenPriceChart.tsx).
  'No market sales yet',
  'No sales in this range',
  ' sales`',
  // S2: Ask b's room and bounty ideas, and the Market / Tickets screens in b's button list.
  'Open my personal room',
  'Why did a room disappear?',
  'Post a bounty in a room',
  'Invite a friend to your room',
  '/m/market,',
  '/m/tickets,',
  // S3: bRadio and NFT burn ("Listed elsewhere" in a store build), and every other "Listed for sale".
  'Listed for sale',
  // S5: wording the widened pass 2 found in setter calls and ternaries.
  'link it and sell it',
  'identity key or sell it',
  'What they sell',
  'is on sale for',
  ' · Play to earn',
  // S8 (CTO + CEO, 16 Nov 2026): no fungible token minting; NFT mints with no price or sale wording.
  'A token or memecoin',
  'Your own token, fixed supply',
  'Mint tickets',
  'Mint a token',
  'Original price (sats)',
  'Choose a picture to see the price',
  'Mint names in bulk',
  'list at tier prices',
  // S9 (CTO + CEO, 16 Nov 2026): an excluded feature says "Not available in this edition", naming no app or site.
  'Open it in bWalletX or on bchatx.com',
  'This room is for token holders',
  'holders. Open it in',
  // A9 (coordinator, 16 Nov 2026): the investor self-certification placeholders must not ship. Removed in
  // fix/hide-investor-status (cb3949e9); never allowlist these.
  'LEGAL REVIEW',
  'Placeholder for the FPO',
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
const UI_KEYS = String.raw`children|title|sub|subtitle|label|"aria-label"|placeholder|description|desc|text|body|hint|note|cta|heading|caption|blurb|tagline|message|alt|summary|detail|intro|empty|reason|error|msg|warning`;
const UI_PROP = new RegExp(String.raw`(?:^|[{,\s])(?:${UI_KEYS}):\s*(${STR})`, 'g');
/**
 * Strings that reach the screen without a UI key (review S5): the message of `new <Name>(…)` / `super(…)` (errors
 * shown with e.message), the only argument of a state setter (setMsg / setNote / setError; minified to a one- or
 * two-letter name), and both literal branches of a ternary. Read only when they look like a sentence (a space and two
 * letters), so ids and class names are not.
 */
const MSG_SOURCES = [
  new RegExp(String.raw`(?:\bnew [\w$.]+|\bsuper)\(\s*(${STR})`, 'g'),
  new RegExp(String.raw`(?<![\w$.])(?:set[A-Z][\w$]*|[\w$]{1,2})\(\s*(${STR})\s*\)`, 'g'),
  new RegExp(String.raw`\?\s*(${STR})\s*:\s*(${STR})?`, 'g'),
];
const sentence = (s) => /[A-Za-z]{2}/.test(s) && /\s/.test(s);

/**
 * The UI strings in a minified JS chunk: UI_KEYS literals; the direct string children of every children:[…]
 * array joined with " … " (a split child like ["Set up $",t,"'s room"]; nested elements are read on their own);
 * and sentence-like MSG_SOURCES (error messages, setter arguments, ternary branches).
 */
export const uiStrings = (js) => {
  const out = [];
  for (const m of js.matchAll(UI_PROP)) out.push(m[1].slice(1, -1));
  const seen = new Set(out);
  for (const re of MSG_SOURCES)
    for (const m of js.matchAll(re))
      for (const g of m.slice(1)) {
        const t = g?.slice(1, -1);
        if (t && sentence(t) && !seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
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

/**
 * True when this file is the script node was asked to run. Node runs the main module from its real path, so the
 * argument is resolved through symlinks and turned into a file URL (spaces → %20, % → %25) before comparing. The
 * old `file://${argv[1]}` test failed open: run through a symlink, or from a path with a space or %, the check
 * printed nothing and exited 0 (review S4).
 */
export const isMain = (url = import.meta.url, argv1 = process.argv[1]) => {
  if (!argv1) return false;
  try {
    return url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
};

if (isMain()) {
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
