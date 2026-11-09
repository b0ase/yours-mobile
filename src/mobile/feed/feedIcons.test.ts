import { describe, expect, test } from 'bun:test';
import { ALL_FEEDS_ICON, feedIcon } from './feedIcons';
import { FEEDS } from './feeds';

describe('feed icons', () => {
  test('real logos where we have them, the bApp icon set otherwise', () => {
    for (const [id, file] of [
      ['bnews', /bnewsx\.png/],
      ['bmovies', /bmoviesx\.png/],
      ['writer', /bwriter\.png/],
      ['bgame', /bgames\.png/],
      ['src-twetch', /twetch\.png/],
      ['src-coingeek', /coingeek\.png/],
    ] as const) {
      const icon = feedIcon(id);
      expect(icon.kind === 'app' && icon.src).toMatch(file);
    }
    expect(feedIcon('bradio')).toEqual({ kind: 'bapp', slug: 'bradio', label: 'bRadio' });
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
