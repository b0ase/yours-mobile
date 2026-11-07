import { describe, expect, test } from 'bun:test';
import { ALL_EMOJI, bigEmojiCount, EMOJI_GROUPS, insertAtCursor, rememberEmoji } from './emoji';

describe('insertAtCursor', () => {
  test('inserts at the caret, mid-sentence', () => {
    expect(insertAtCursor('hello world', 5, 5, ' 👋')).toEqual({ value: 'hello 👋 world', caret: 8 });
  });

  test('replaces a selection', () => {
    expect(insertAtCursor('I am sad', 5, 8, '😀')).toEqual({ value: 'I am 😀', caret: 7 });
  });

  test('at the start, and at the end', () => {
    expect(insertAtCursor('hi', 0, 0, '🔥')).toEqual({ value: '🔥hi', caret: 2 });
    expect(insertAtCursor('hi', 2, 2, '🔥')).toEqual({ value: 'hi🔥', caret: 4 });
  });

  test('an unknown caret (null) goes to the end', () => {
    expect(insertAtCursor('hi', null, null, '🎉')).toEqual({ value: 'hi🎉', caret: 4 });
    expect(insertAtCursor('', undefined, undefined, '🎉')).toEqual({ value: '🎉', caret: 2 });
  });

  test('a stale caret past the end (draft got shorter) is clamped', () => {
    expect(insertAtCursor('ab', 10, 12, '❤️')).toEqual({ value: 'ab❤️', caret: 4 });
  });

  test('a backwards selection never duplicates text', () => {
    expect(insertAtCursor('abcdef', 4, 2, 'X')).toEqual({ value: 'abcdXef', caret: 5 });
  });
});

describe('the local emoji set', () => {
  test('no remote anything: every entry is a short emoji string', () => {
    expect(ALL_EMOJI.length).toBeGreaterThan(300);
    for (const e of ALL_EMOJI) {
      expect(e.length).toBeLessThanOrEqual(8);
      expect(/[a-z0-9]/i.test(e)).toBe(false);
      expect(/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e)).toBe(true);
    }
  });

  test('every group has emoji and a tab icon', () => {
    for (const g of EMOJI_GROUPS) {
      expect(g.emoji.length).toBeGreaterThan(10);
      expect(g.icon).toBe(g.emoji[0]);
    }
  });
});

describe('bigEmojiCount (native emoji drawn large)', () => {
  test('1–3 emoji only', () => {
    expect(bigEmojiCount('🔥')).toBe(1);
    expect(bigEmojiCount(' 😂😂 ')).toBe(2);
    expect(bigEmojiCount('👍🏽❤️🎉')).toBe(3);
    expect(bigEmojiCount('👨‍👩‍👧')).toBe(1);
  });

  test('words, numbers, many emoji or nothing: normal size', () => {
    expect(bigEmojiCount('lol 😂')).toBe(0);
    expect(bigEmojiCount('1')).toBe(0);
    expect(bigEmojiCount('#')).toBe(0);
    expect(bigEmojiCount('😀😀😀😀')).toBe(0);
    expect(bigEmojiCount('')).toBe(0);
    expect(bigEmojiCount(null)).toBe(0);
  });
});

describe('recent emoji', () => {
  test('moves a pick to the front without duplicates (works without storage)', () => {
    expect(rememberEmoji('🔥', ['😀', '🔥', '🎉'])).toEqual(['🔥', '😀', '🎉']);
  });
});
