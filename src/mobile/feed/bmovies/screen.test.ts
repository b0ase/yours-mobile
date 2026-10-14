import { describe, expect, test } from 'bun:test';
import { BLOCKED_HANDLES, isBlocked } from './screen';

const base = { title: 'A dance clip', blurb: 'Made with love', ticker: 'DANCE', handle: 'artist', tweetId: '123' };

describe('NSFW screen', () => {
  test('drops the はだかつ item', () => {
    expect(
      isBlocked({
        ...base,
        title: 'はだかつ',
        blurb: 'Simple & KAWAII Dance… SFW illustration & Movie. No nudity…',
      }),
    ).toBe(true);
  });
  test('normal items pass', () => {
    expect(isBlocked(base)).toBe(false);
  });
  test('case-insensitive terms in any field', () => {
    expect(isBlocked({ ...base, ticker: 'NSFW' })).toBe(true);
    expect(isBlocked({ ...base, handle: 'LewdArt' })).toBe(true);
    expect(isBlocked({ ...base, blurb: '야한 영상' })).toBe(true);
  });
  test('blocklisted handle is dropped', () => {
    (BLOCKED_HANDLES as string[]).push('Bad_Actor');
    try {
      expect(isBlocked({ ...base, handle: 'bad_actor' })).toBe(true);
    } finally {
      (BLOCKED_HANDLES as string[]).pop();
    }
  });
});
