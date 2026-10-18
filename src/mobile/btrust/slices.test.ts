import { describe, expect, test } from 'bun:test';
import { PrivateKey, Utils } from '@bsv/sdk';
import { makeSlices, parseCard, restoreKey, restoreSecret, slicesForKey } from './slices';
import { openPaper, parsePaper, sealPaper } from './papers';

const secret = Utils.toArray(
  'abandon ability able about above absent absorb abstract absurd abuse access accident',
  'utf8',
);

describe('recovery slices 2-of-3', () => {
  const { cards } = makeSlices(secret);
  test('three cards, same set', () => {
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((c) => c.setId)).size).toBe(1);
    expect(cards.map((c) => c.index)).toEqual([1, 2, 3]);
  });
  test('any two restore the secret', () => {
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 0],
    ])
      expect(restoreSecret([cards[a].text, cards[b].text])).toEqual(secret);
    expect(restoreSecret(cards.map((c) => c.text))).toEqual(secret);
  });
  test('one card alone, or two copies of one card, does not', () => {
    expect(() => restoreSecret([cards[0].text])).toThrow('at least two');
    expect(() => restoreSecret([cards[1].text, cards[1].text])).toThrow('copies');
  });
  test('a card does not contain the secret in plain text', () => {
    for (const c of cards) expect(c.text).not.toContain('abandon');
  });
  test('cards from different sets are refused', () => {
    const other = makeSlices(secret).cards;
    expect(() => restoreSecret([cards[0].text, other[1].text])).toThrow('different sets');
  });
  test('a damaged card is refused', () => {
    const t = cards[0].text;
    // Change the 6th-from-last character to a different one (the old check looked at the last character, so it
    // sometimes swapped a character for itself and the test flaked).
    const bad = t.slice(0, -6) + (t.at(-6) === 'A' ? 'B' : 'A') + t.slice(-5);
    expect(() => parseCard(bad)).toThrow();
    expect(() => parseCard('hello')).toThrow('not a bTrust slice');
  });
});

describe('n-of-m', () => {
  test('3-of-5: any three restore, two do not', () => {
    const { cards } = makeSlices(secret, 3, 5);
    expect(restoreSecret([cards[4].text, cards[0].text, cards[2].text])).toEqual(secret);
    expect(() => restoreSecret([cards[0].text, cards[1].text])).toThrow();
  });
  test('every pair of a 2-of-5 set restores; threshold-1 of 4-of-6 does not', () => {
    const five = makeSlices(secret, 2, 5).cards;
    for (let a = 0; a < 5; a++)
      for (let b = a + 1; b < 5; b++) expect(restoreSecret([five[a].text, five[b].text])).toEqual(secret);
    const six = makeSlices(secret, 4, 6).cards;
    expect(() => restoreSecret(six.slice(0, 3).map((c) => c.text))).toThrow();
    expect(restoreSecret(six.slice(2).map((c) => c.text))).toEqual(secret);
  });
  test('a card with a swapped ciphertext but the same set id is refused', () => {
    const { cards } = makeSlices(secret);
    const p = cards[1].text.split(':');
    const forged = [...p.slice(0, 4), makeSlices(secret).cards[0].text.split(':')[4]].join(':');
    expect(() => restoreSecret([cards[0].text, forged])).toThrow();
  });
  test('refuses silly counts', () => {
    expect(() => makeSlices(secret, 1, 3)).toThrow();
    expect(() => makeSlices(secret, 4, 3)).toThrow();
    expect(() => makeSlices(secret, 2, 17)).toThrow();
    expect(() => makeSlices([], 2, 3)).toThrow();
  });
});

describe('important papers', () => {
  const trustKey = PrivateKey.fromRandom();
  const cards = slicesForKey(trustKey, secret);
  const doc = Utils.toArray('Last will and testament of A. Person', 'utf8');
  const sealed = sealPaper(trustKey, { name: 'will.txt', type: 'text/plain', bytes: doc });
  test('heirs open the paper with two slices', () => {
    const { trustKey: k } = restoreKey([cards[0].text, cards[2].text]);
    expect(openPaper(k, parsePaper(JSON.stringify(sealed)))).toEqual(doc);
  });
  test('the sealed file holds no plaintext, and the wrong key fails', () => {
    expect(JSON.stringify(sealed)).not.toContain('testament');
    expect(() => openPaper(PrivateKey.fromRandom(), sealed)).toThrow('do not open');
  });
  test('a swapped hash is caught', () => {
    expect(() => openPaper(trustKey, { ...sealed, sha256: '00'.repeat(32) })).toThrow('changed');
  });
});
