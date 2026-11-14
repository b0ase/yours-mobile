import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Strings from the removed static share listings and the bApps alphabet-share offers. None may ship: the web build
 * (vite.config.web.ts, noShareOffersInBundle) fails if its output carries one, and src/mobile/market/sharesView.test.ts
 * checks the app source. Kept outside src/ so the source check does not find this list.
 */
export const REMOVED_OFFER_STRINGS = [
  'bcorp-ordinary',
  'Register interest',
  'Interest registered',
  'alphabet-share',
  '1,000,000,000 (placeholder)',
  'Share offers are for verified investors',
  'To be confirmed from the Register of Members',
  "the issuer's responsibility; The Bitcoin Corporation does not endorse",
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

/** Every "<file>: <string>" where a built .js or .html file under `dir` carries a removed offer string. */
export function offerStringsInBundle(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return files(dir)
    .filter((f) => /\.(js|html)$/.test(f))
    .flatMap((f) => {
      const t = readFileSync(f, 'utf8');
      return REMOVED_OFFER_STRINGS.filter((s) => t.includes(s)).map((s) => `${f}: ${s}`);
    });
}
