import { describe, expect, it } from 'bun:test';
import { accentById } from '../theme/accents';
import { cardFollowsTheme, cardPatternColour } from './cardLook';

describe('card theme-follow vs customised', () => {
  const white = accentById('white');
  const blue = accentById('blue');
  const gold = accentById('gold');
  it('an uncustomised card follows a full pack (White, Blue, Duo/Tri)', () => {
    expect(cardFollowsTheme(white, false)).toBe(true);
    expect(cardFollowsTheme(blue, false)).toBe(true);
    expect(cardFollowsTheme(accentById('cyber'), false)).toBe(true);
    expect(cardPatternColour(blue, false, '#123456')).toBe(blue.accent);
  });
  it('a customised card keeps its own look in every theme', () => {
    for (const p of [white, blue, gold, accentById('cyber')]) {
      expect(cardFollowsTheme(p, true)).toBe(false);
      expect(cardPatternColour(p, true, '#123456')).toBe('#123456');
    }
  });
  it('Gold and accent-only colours restyle no card', () => {
    expect(cardFollowsTheme(gold, false)).toBe(false);
    expect(cardFollowsTheme(accentById('silver'), false)).toBe(false);
  });
});
