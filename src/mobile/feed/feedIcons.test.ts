import { describe, expect, test } from 'bun:test';
import { ALL_FEEDS_ICON, feedIcon } from './feedIcons';
import { FEEDS, type FeedId } from './feeds';

describe('feed icons', () => {
  test('bApp feeds use their own bApp art', () => {
    const bmovies = feedIcon('bmovies');
    expect(bmovies.kind).toBe('app');
    expect(bmovies.kind === 'app' && bmovies.src).toMatch(/bmovies\.png/);
    const bnews = feedIcon('bnews');
    expect(bnews.kind).toBe('app');
    expect(bnews.kind === 'app' && bnews.src).toMatch(/bnews\.svg/);
  });

  test('Following, For you and All feeds get gold glyphs', () => {
    expect(feedIcon('following')).toEqual({ kind: 'glyph', glyph: 'following' });
    expect(feedIcon('foryou')).toEqual({ kind: 'glyph', glyph: 'foryou' });
    expect(ALL_FEEDS_ICON).toEqual({ kind: 'glyph', glyph: 'all' });
  });

  test('every feed has an icon; an unknown id falls back to a glyph', () => {
    for (const f of FEEDS) expect(feedIcon(f.id)).toBeTruthy();
    expect(feedIcon('later' as FeedId)).toEqual({ kind: 'glyph', glyph: 'foryou' });
  });
});
