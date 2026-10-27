import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bavatarSvg, blendFor, bavatarSeed, variantSeed } from './bavatar';
import { bavatarDataUri } from '../names/avatar';

const K = '02' + 'ab'.repeat(32);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('bAvatars (copy of bit-sign lib/bavatar)', () => {
  test('same key → same SVG, different keys differ', () => {
    expect(bavatarSvg(K)).toBe(bavatarSvg(K));
    expect(bavatarSvg(K)).not.toBe(bavatarSvg('03' + 'cd'.repeat(32)));
  });
  test('byte-identical to bChatX (bit-sign src/lib/bavatar/bavatar.ts at merge e11bdae9)', () => {
    // If this fails, the two copies have drifted: copy bit-sign's file over this one.
    expect(sha(bavatarSvg(K, { size: 128 }))).toBe('b80f040d370fee126744bec7e478cf0121232d238b18e59b212397bca3f64162');
    expect(sha(bavatarSvg('alice', { size: 128 }))).toBe(
      '311892148adc2f604ef58abfc0fa75bf6bdda3a5a4a115df24d9f9347186bd17',
    );
  });
  test('design #0 is the original, unchanged; #n draws from `${key}#${n}`', () => {
    expect(bavatarSvg(K, { variant: 0 })).toBe(bavatarSvg(K));
    expect(bavatarSvg(K, { variant: 1 })).not.toBe(bavatarSvg(K));
    expect(bavatarSvg(K, { variant: 1 })).not.toBe(bavatarSvg(K, { variant: 2 }));
    expect(variantSeed(K, 0)).toBe(K);
    expect(variantSeed(K, 5)).toBe(`${K}#5`);
    expect(() => bavatarSvg(K, { variant: -1 })).toThrow();
    expect(() => bavatarSvg(K, { variant: 1.5 })).toThrow();
  });
  // ⚠ SAME TABLE in bit-sign bavatar-selftest.mts. Both copies must draw these exact bytes for (key, design):
  // if one side changes, both tests must be updated together or the server will refuse wallet mints.
  test('designs are byte-identical to bChatX (shared known-answer table)', () => {
    const table: [string, number, string][] = [
      ['02' + 'ab'.repeat(32), 0, '5bb94c0937bf13aa0a397a9c971a706d4c11863be4f2a2f3738ee00d4717bc3b'],
      ['02' + 'ab'.repeat(32), 1, '884abc7cee00d756302274c7d62d0135dab41c98af10689b64fe000c86f5d39d'],
      ['02' + 'ab'.repeat(32), 2, 'b569b270e1fd08a9e7ad99eb5f291fc1382d94ec771ecf2f4bd953b3401d11fe'],
      ['03' + 'cd'.repeat(32), 1, '11339e4043cbe80b788bd0a35ce9beef98f087b8b4e3fcd63cbe76e2471678bb'],
      ['03' + 'cd'.repeat(32), 42, '895b21fa8a08aaf71699df3e998ba9459a2c6b0dc0e52fe7ee5e9ea1322bfc83'],
      ['alice', 3, 'de6c24403726834d6ba93a387929e44b928e016962a8cbb48decd647011f2f62'],
      ['02' + '0f'.repeat(32), 9999, '889889a6e2a1995e7182f7d6abe72f318e0075ae6e2eb64ce41424bc8719e74c'],
    ];
    for (const [key, n, hash] of table) expect(sha(bavatarSvg(key, { size: 512, variant: n }))).toBe(hash);
  });
  test('every blend is Bloom + 2–3 layers', () => {
    for (let i = 0; i < 100; i++) {
      const { styles } = blendFor(bavatarSeed('n' + i));
      expect(styles[0]).toBe('bloom');
      expect(styles.length >= 3 && styles.length <= 4).toBe(true);
    }
  });
  test('the account fallback is a data URI for a real key, empty otherwise', () => {
    expect(bavatarDataUri(K).startsWith('data:image/svg+xml')).toBe(true);
    expect(bavatarDataUri(K)).toBe(bavatarDataUri(K.toUpperCase()));
    expect(bavatarDataUri('')).toBe('');
    expect(bavatarDataUri('not-a-key')).toBe('');
  });
});
