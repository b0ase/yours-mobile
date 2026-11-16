#!/usr/bin/env node
/**
 * Reads a BUILT store bundle and fails if it carries wording the store edition must not ship: exchanges and
 * markets, trading, token sales, launch curves, token rooms, games with stakes, PNEEs offers, priced names.
 * Source-level gates are tested in src/mobile/storeBuild.test.ts; this checks the output, where a missed gate shows.
 *
 *   node scripts/store-bundle-check.mjs [dir]      (default: build-mobile; it must be a store build)
 *   pnpm check:store-bundle                         builds the store bundle first, then runs this
 *
 * Exit 1 lists every hit as file + text around it. Add to BANNED when a gate is added; add to ALLOWED only with
 * the reason the text has to stay.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
];

/** Banned text that is allowed in one place, with the reason. Matched as "<banned text>" inside a file whose name starts with the key. */
export const ALLOWED = [];

const TEXT = /\.(js|mjs|css|html|json|webmanifest|txt|svg)$/;

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
  if (hits.length) {
    console.error(`store-bundle-check: ${hits.length} banned string(s) in ${dir}:`);
    for (const h of hits) console.error(`  ${h.file}: "${h.text}" … ${h.around}`);
    process.exit(1);
  }
  console.log(`store-bundle-check: ${dir} is clean (${BANNED.length} strings checked)`);
}
