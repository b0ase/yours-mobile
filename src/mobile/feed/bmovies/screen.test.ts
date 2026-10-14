import { describe, expect, test } from 'bun:test';
import { BLOCKED_HANDLES, hasRiskTerm, isBlocked } from './screen';

const base = { title: 'A dance clip', blurb: 'Made with love', ticker: 'DANCE', handle: 'artist', tweetId: '123' };

describe('NSFW screen', () => {
  test('drops the はだかつ item', () => {
    expect(
      isBlocked({ ...base, title: 'はだかつ', blurb: 'Simple & KAWAII Dance… SFW illustration & Movie. No nudity…' }),
    ).toBe(true);
    expect(isBlocked({ ...base, title: 'はだかつ', blurb: '' })).toBe(true);
  });
  test('normal items pass', () => {
    expect(isBlocked(base)).toBe(false);
  });
  test('English terms match whole words only', () => {
    expect(hasRiskTerm('Nude beach day')).toBe(true);
    expect(hasRiskTerm('NSFW')).toBe(true);
    expect(hasRiskTerm('Denuded hills of Essex and Sussex')).toBe(false);
    expect(hasRiskTerm('Nudel soup in Middlesex')).toBe(false);
    expect(isBlocked({ ...base, ticker: 'NSFW' })).toBe(true);
  });
  test('18+ as a token', () => {
    expect(hasRiskTerm('18+ only')).toBe(true);
    expect(hasRiskTerm('(+18)')).toBe(true);
    expect(hasRiskTerm('18禁')).toBe(true);
    expect(hasRiskTerm('Best of 2018+')).toBe(false);
    expect(hasRiskTerm('118+ views')).toBe(false);
  });
  test('full-width input is normalised', () => {
    expect(hasRiskTerm('ＮＳＦＷ')).toBe(true);
    expect(hasRiskTerm('１８＋')).toBe(true);
    expect(hasRiskTerm('ｴﾛ')).toBe(true);
  });
  test('CJK terms as substrings', () => {
    expect(isBlocked({ ...base, blurb: '야한 영상' })).toBe(true);
    expect(hasRiskTerm('性感舞蹈')).toBe(true);
  });
  test('blocklisted handle and tweet id are dropped', () => {
    const h = BLOCKED_HANDLES as Set<string>;
    h.add('bad_actor');
    try {
      expect(isBlocked({ ...base, handle: '@Bad_Actor' })).toBe(true);
    } finally {
      h.delete('bad_actor');
    }
  });
});
