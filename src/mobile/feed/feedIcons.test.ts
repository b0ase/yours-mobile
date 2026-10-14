import { describe, expect, test } from 'bun:test';
import { ALL_FEEDS_ICON, feedIcon } from './feedIcons';
import { FEEDS } from './feeds';

describe('feed icons', () => {
  test('bApp feeds use their own bApp art', () => {
    const bmovies = feedIcon('bmovies');
    expect(bmovies.kind === 'app' && bmovies.src).toMatch(/bmovies\.png/);
    const bnews = feedIcon('bnews');
    expect(bnews.kind === 'app' && bnews.src).toMatch(/bnews\.svg/);
    const writer = feedIcon('writer');
    expect(writer.kind === 'app' && writer.src).toMatch(/bwriter\.png/);
  });

  test('Following, For you and All feeds get glyphs; a bApp without art gets its initial', () => {
    expect(feedIcon('following')).toEqual({ kind: 'glyph', glyph: 'following' });
    expect(feedIcon('foryou')).toEqual({ kind: 'glyph', glyph: 'foryou' });
    expect(ALL_FEEDS_ICON).toEqual({ kind: 'glyph', glyph: 'all' });
    expect(feedIcon('bradio')).toEqual({ kind: 'letter', letter: 'R' });
    expect(feedIcon('path402')).toEqual({ kind: 'letter', letter: '4' });
  });

  test('every feed has an icon; an unknown id falls back to a glyph', () => {
    for (const f of FEEDS) expect(feedIcon(f.id)).toBeTruthy();
    expect(feedIcon('later')).toEqual({ kind: 'glyph', glyph: 'foryou' });
  });
});
