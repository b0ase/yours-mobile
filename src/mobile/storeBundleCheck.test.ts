import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error plain .mjs script, no type declarations
import { BANNED, scan } from '../../scripts/store-bundle-check.mjs';

/**
 * scripts/store-bundle-check.mjs reads a BUILT store bundle for wording the store edition must not ship
 * (`pnpm check:store-bundle` builds one and runs it). These tests cover the checker itself, and read a store bundle
 * when one is there: set STORE_BUNDLE_DIR to a store build's output dir (the release gate does) to run that one.
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
      'ticker:"PNEEs · USD¢";t="Index your token";u="Not available in this edition"',
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
  const built = process.env.STORE_BUNDLE_DIR;
  test.skipIf(!built || !existsSync(built ?? ''))('the built store bundle in STORE_BUNDLE_DIR is clean', () => {
    expect(scan(built)).toEqual([]);
  });
});
