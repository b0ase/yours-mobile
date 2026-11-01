import { describe, expect, test } from 'bun:test';
import { badgeLabel, hashCandidates, matchProofs, normalizeText, textMatches, type PostRef } from './match';
import type { VerifiedProof } from './record';

describe('normalizeText (AuthSig: collapse whitespace, trim)', () => {
  test.each([
    ['  hello   world \n', 'hello world'],
    ['a\n\nb\tc', 'a b c'],
    ['', ''],
    [' x ', 'x'],
  ])('%j → %j', (a, b) => expect(normalizeText(a)).toBe(b));
});

describe('textMatches', () => {
  test('same text after normalising', () => {
    expect(textMatches('How many switch ports total', ' How many  switch ports total\n')).toBe(true);
  });
  test('compose-box text (line breaks) matches X’s textContent (paragraphs run together)', () => {
    // AuthSig's mainnet records show X's textContent loses paragraph breaks: "…imo.Proof delivery…"
    expect(
      textMatches(
        'Firehoses are the future imo.\nProof delivery too',
        'Firehoses are the future imo.Proof delivery too',
      ),
    ).toBe(true);
  });
  test('different text does not match', () => {
    expect(textMatches('How many switch ports total', 'How many switch ports in total')).toBe(false);
    expect(textMatches('', 'x')).toBe(false);
  });
  test('a truncated post ("Show more") matches on a 20+ character prefix only', () => {
    const full = 'This is a long post that X cuts off in the timeline, and it goes on and on.';
    expect(textMatches(full, 'This is a long post that X cuts off…', { truncated: true })).toBe(true);
    expect(textMatches(full, 'This is a long post that X cuts off…')).toBe(false);
    expect(textMatches(full, 'This is…', { truncated: true })).toBe(false);
    expect(textMatches(full, 'Something else entirely, long enough', { truncated: true })).toBe(false);
  });
});

describe('hashCandidates', () => {
  test('raw, trimmed and normalised, de-duplicated', () => {
    expect(hashCandidates([' a  b '])).toEqual([' a  b ', 'a  b', 'a b']);
    expect(hashCandidates(['x', 'x'])).toEqual(['x']);
    expect(hashCandidates(['   '])).toEqual(['   ']);
  });
});

const proof = (over: Partial<VerifiedProof>): VerifiedProof => ({
  key: 'x-post-1',
  content: 'hello world',
  publicKey: '02' + '1'.repeat(64),
  signedAt: '2026-10-30T10:00:00.000Z',
  source: 'authsig',
  ...over,
});

describe('matchProofs', () => {
  const alice = '02' + 'a'.repeat(64);
  const bob = '03' + 'b'.repeat(64);
  const hashKey = 'c'.repeat(64);

  test('an x-post proof attaches to its post only when the signed text matches the post', () => {
    const posts: PostRef[] = [
      { id: 'p1', xKey: 'x-post-1', texts: ['hello  world'], hashes: [] },
      { id: 'p2', xKey: 'x-post-2', texts: ['edited text'], hashes: [] },
    ];
    const m = matchProofs(posts, {
      'x-post-1': [proof({ publicKey: alice })],
      'x-post-2': [proof({ key: 'x-post-2', content: 'original text', publicKey: alice })],
    });
    expect(m.get('p1')?.map((p) => p.publicKey)).toEqual([alice]);
    expect(m.has('p2')).toBe(false);
  });

  test('a content-hash proof attaches through the page text that produced the hash', () => {
    const posts: PostRef[] = [{ id: 'p', texts: ['a comment'], hashes: [{ key: hashKey, text: 'a comment' }] }];
    const m = matchProofs(posts, { [hashKey]: [proof({ key: hashKey, content: 'a comment', publicKey: bob })] });
    expect(m.get('p')?.[0].publicKey).toBe(bob);
  });

  test('one entry per signer (their earliest), oldest first', () => {
    const posts: PostRef[] = [
      { id: 'p', xKey: 'x-post-1', texts: ['hello world'], hashes: [{ key: hashKey, text: 'hello world' }] },
    ];
    const m = matchProofs(posts, {
      'x-post-1': [
        proof({ publicKey: bob, signedAt: '2026-10-31T00:00:00.000Z' }),
        proof({ publicKey: alice, signedAt: '2026-10-30T12:00:00.000Z' }),
      ],
      [hashKey]: [proof({ key: hashKey, publicKey: alice, signedAt: '2026-10-29T00:00:00.000Z' })],
    });
    expect(m.get('p')?.map((p) => [p.publicKey, p.signedAt])).toEqual([
      [alice, '2026-10-29T00:00:00.000Z'],
      [bob, '2026-10-31T00:00:00.000Z'],
    ]);
  });

  test('keys that are not proof keys are ignored', () => {
    const posts: PostRef[] = [
      { id: 'p', xKey: 'nope', texts: ['hello world'], hashes: [{ key: 'short', text: 'hello world' }] },
    ];
    expect(matchProofs(posts, { nope: [proof({})], short: [proof({})] }).size).toBe(0);
  });
});

describe('badgeLabel', () => {
  const k1 = '02' + '1'.repeat(64);
  const k2 = '02' + '2'.repeat(64);
  test('names only when checked, "you" for the user, +N for more', () => {
    expect(badgeLabel([{ publicKey: k1 }])).toBe('signed');
    expect(badgeLabel([{ publicKey: k1, name: '$alice' }])).toBe('signed by $alice');
    expect(badgeLabel([{ publicKey: k1 }, { publicKey: k2, name: '$bob' }])).toBe('signed by $bob +1');
    expect(badgeLabel([{ publicKey: k1, name: '$alice' }, { publicKey: k2 }], k2)).toBe('signed by you +1');
    expect(badgeLabel([])).toBe('');
  });
});
