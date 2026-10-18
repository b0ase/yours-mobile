import { describe, expect, test } from 'bun:test';
import { EMOJI_THEMES } from '../theme/emojiThemes';
import { emojiArtUri, emojiCardSvg, emojiTileUri } from './cardPatternsEmoji';
import { patternUri } from './cardPatterns';
import { TWEMOJI } from './emojiArt/twemoji';
import { receiptArtUrl } from '../storeReceipt/art';

describe('emoji card art', () => {
  test('every emoji theme has its self-hosted Twemoji and small, self-contained art', () => {
    for (const e of EMOJI_THEMES) {
      expect(TWEMOJI[e.code], e.id).toBeTruthy();
      const svg = emojiCardSvg(e);
      expect(svg).toContain(TWEMOJI[e.code] as string);
      expect(svg.length).toBeLessThan(12_000);
      // Nothing fetched from outside the picture (an <img> would refuse it anyway).
      expect(/https?:\/\/(?!www\.w3\.org)/.test(svg)).toBe(false);
      expect(emojiArtUri(e.id)).toMatch(/^data:image\/svg\+xml/);
      expect([emojiArtUri(e.id, 0), emojiArtUri(e.id, 1)]).toContain(patternUri(e.id, e.accent, 'card-1'));
      expect(emojiTileUri(e.id)).toMatch(/^data:image\/svg\+xml/);
      expect(receiptArtUrl(e.id)).toBe(emojiTileUri(e.id, 256));
    }
    expect(emojiArtUri('nope')).toBe('');
  });
});
