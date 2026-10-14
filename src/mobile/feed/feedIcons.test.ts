import { describe, expect, test } from 'bun:test';
import { ALL_FEEDS_ICON, feedIcon } from './feedIcons';
import { FEEDS } from './feeds';

describe('feed icons', () => {
  test('$b* feeds use the bApp icon set', () => {
    expect(feedIcon('bnews')).toEqual({ kind: 'bapp', slug: 'bnews', label: 'bNews' });
    expect(feedIcon('writer')).toEqual({ kind: 'bapp', slug: 'writer', label: 'bWriter' });
    expect(feedIcon('bradio')).toEqual({ kind: 'bapp', slug: 'bradio', label: 'bRadio' });
    // No glyph yet: still a bApp icon (the set's initial fallback).
    expect(feedIcon('bmaps')).toEqual({ kind: 'bapp', slug: 'bmaps', label: 'bMaps' });
  });

  test('Home and All feeds get glyphs; ventures keep their art or initial', () => {
    expect(feedIcon('home')).toEqual({ kind: 'glyph', glyph: 'home' });
    expect(ALL_FEEDS_ICON).toEqual({ kind: 'glyph', glyph: 'all' });
    expect(feedIcon('path402')).toEqual({ kind: 'letter', letter: '4' });
    expect(feedIcon('vexvoid')).toEqual({ kind: 'letter', letter: 'V' });
    const tb = feedIcon('tokenblaster');
    expect(tb.kind === 'app' && tb.src).toMatch(/tokenblaster\.png/);
  });

  test('every feed has an icon; an unknown id falls back to a glyph', () => {
    for (const f of FEEDS) expect(feedIcon(f.id)).toBeTruthy();
    expect(feedIcon('later')).toEqual({ kind: 'glyph', glyph: 'foryou' });
  });
});
