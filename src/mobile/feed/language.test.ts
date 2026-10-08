import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILTER_NOTE, languageOf, languageView, nameView, safeName, HIDDEN_NAME } from './language';
import { languageOptsFor } from '../storeBuild';

/**
 * Feed bad-language filter. language.ts + language-lists.json are copies of bit-sign's
 * src/lib/feed/language.ts / language-lists.json; the list hash is pinned in BOTH repos' tests
 * (bit-sign language-selftest.mts), and the same cases run in both.
 */
const LISTS = join(import.meta.dir, 'language-lists.json');
const PINNED = 'fb75e3c789855bba33e5cd30cdf8a4378c61753f634f9492d02da74b5c348e7d';

describe('language list', () => {
  test('matches the hash pinned in bit-sign', () => {
    expect(createHash('sha256').update(readFileSync(LISTS)).digest('hex')).toBe(PINNED);
  });
  test('matcher source identical to bit-sign checkout (when present)', () => {
    const sib = join(import.meta.dir, '../../../../bit-sign/src/lib/feed/language.ts');
    if (!existsSync(sib) || !readFileSync(sib, 'utf8').includes('language-lists.json')) return;
    expect(readFileSync(join(import.meta.dir, 'language.ts'), 'utf8')).toBe(readFileSync(sib, 'utf8'));
  });
});

const SLUR = [
  'you are a nigger',
  'NIGGERS everywhere',
  'n1gg3r',
  'n i g g e r',
  'n.i.g.g.e.r',
  'niiiiggggerrr',
  'n*gger',
  '@antinigger',
  'what a faggot',
  'f@gg0t',
  'fa66ot',
  'stupid retard',
  'r3tard',
  'such a tranny',
  'kike',
  'spics go home',
  'chinks',
  'paki',
  'porch monkey',
  'n​igger',
  'nіgger' /* cyrillic і */,
  'you sandniggers',
  'r-e-t-a-r-d',
  'ret@rded',
];
const STRONG = [
  'fuck this',
  'what the fuuuuck',
  'f*ck',
  'f**k off',
  'f.u.c.k',
  'f u c k',
  'sh1t happens',
  '$hit',
  'bullshitting',
  'motherfuckers',
  'clusterfuck',
  'fuckwit',
  'you cunt',
  'son of a bitch',
  'asshole',
  'a$$hole',
  'wanker',
  'bollocks',
  'shitcoin',
];
const CLEAN = [
  'Scunthorpe United won',
  'I live in Penistone near Sheffield',
  'he began to snigger',
  'sniggering at the back',
  'Niger and Nigeria',
  'Nigerian food',
  'the hospice is lovely',
  'spicy food and spices',
  'a chink in the armour.',
  'Chink of light',
  'Pakistan cricket',
  'fire retardant',
  'shiitake mushrooms',
  'Yamashita and Matsushita',
  'Shiite muslims',
  'Gok Wan',
  'Dickens novels',
  'cocktail hour',
  'swanky bar',
  'Wankel engine',
  'classic assassin',
  'Sussex and Essex',
  'bass guitar',
  'the therapist',
  'Hancock',
  'grape soda',
  'a mishit shot',
  'border collie',
  'Spicer',
  'Wogan',
  '1337 h4x0r',
  '*bold* text',
  'shot',
  'I am a fan',
  'ok 👍',
  '',
  'Van Dyke',
  'he is retarding progress? no: delayed',
  'Ash it later',
];

describe('languageOf', () => {
  test.each(SLUR)('slur: %p', (t) => expect(languageOf(t)).toBe('slur'));
  test.each(STRONG)('strong: %p', (t) => expect(languageOf(t)).toBe('strong'));
  test.each(CLEAN)('clean: %p', (t) => expect(languageOf(t)).toBeNull());
  test('slur beats strong', () => expect(languageOf('fuck you nigger')).toBe('slur'));
  test('slur names read Hidden name', () => {
    expect(safeName('xX_n1gger_Xx')).toBe(HIDDEN_NAME);
    expect(safeName('Richard')).toBe('Richard');
  });
});

describe('edition behaviour', () => {
  const off = { filterStrong: false };
  const on = { filterStrong: true };
  test('store edition: slurs hidden with no reveal, even with the prefs set', () => {
    expect(languageView('slur', languageOptsFor(on, true))).toBe('hide-final');
  });
  test('store edition: swearing always blurred behind Show anyway', () => {
    expect(languageView('strong', languageOptsFor(off, true))).toBe('blur');
  });
  test('bWalletX: swearing shown by default, blurred with Filter strong language', () => {
    expect(languageView('strong', languageOptsFor(off, false))).toBe('show');
    expect(languageView('strong', languageOptsFor({ ...off, filterStrong: true }, false))).toBe('blur');
  });
  test('bWalletX: slurs blurred behind Show anyway, no 18+ opt-in', () => {
    expect(languageView('slur', languageOptsFor(off, false))).toBe('blur');
    expect(languageView('slur', languageOptsFor(on, false))).toBe('blur');
  });
  test('names: blurred in bWalletX, Hidden name in the store edition', () => {
    expect(nameView('xX_n1gger_Xx', { store: languageOptsFor(off, false).store })).toBe('blur');
    expect(nameView('xX_n1gger_Xx', { store: languageOptsFor(off, true).store })).toBe('hidden');
    expect(nameView('Richard', { store: true })).toBe('show');
  });
  test('the old 18+ pref is ignored', () => {
    const legacy = { filterStrong: false, allowLanguageReveal: true } as { filterStrong: boolean };
    expect(languageView('slur', languageOptsFor(legacy, true))).toBe('hide-final');
    expect(Object.keys(languageOptsFor(legacy, false)).sort()).toEqual(['filterStrong', 'store']);
  });
  test('filter note', () =>
    expect(FILTER_NOTE).toBe(
      'Filters only change what you see. Nothing is deleted: posts stay on-chain and readable in any app.',
    ));
  test('clean text always shown', () => expect(languageView(null, languageOptsFor(on, true))).toBe('show'));
});
