import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './messages';
import {
  applyMention,
  mentionParts,
  mentionQuery,
  mentionSuggestions,
  reactionsByMessage,
  replyOf,
  replyRefFor,
  typingLabel,
} from './social';

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36),
  author_handle: 'alice',
  kind: 'text',
  body: 'hi',
  created_at: '2026-10-08T10:00:00Z',
  ...p,
});
const react = (target: string, emoji: string, by: string, op = 'add') =>
  msg({ kind: 'event', event_type: 'reaction', author_handle: by, event_payload: { target, emoji, op, by } });

describe('reactions', () => {
  test('replays add/remove per person', () => {
    const r = reactionsByMessage([
      react('m1', '👍', 'alice'),
      react('m1', '👍', 'bob'),
      react('m1', '❤️', 'bob'),
      react('m1', '👍', 'alice', 'remove'),
      react('m1', '❤️', 'bob', 'remove'),
    ]);
    expect(r.get('m1')).toEqual([{ emoji: '👍', handles: ['bob'] }]);
  });
  test('nothing for unreacted messages', () => {
    expect(reactionsByMessage([msg({})]).size).toBe(0);
  });
});

describe('replies', () => {
  test('round trip', () => {
    const parent = msg({ id: 'p', author_handle: '$Alice', body: 'line one\nline two' });
    const ref = replyRefFor(parent);
    expect(ref).toEqual({ id: 'p', author: 'alice', snippet: 'line one line two' });
    expect(replyOf(msg({ event_payload: { reply_to: ref } }))).toEqual(ref);
    expect(replyOf(msg({}))).toBeNull();
  });
});

describe('mentions', () => {
  test('splits $handles, not money', () => {
    expect(mentionParts('hi $alice, that is $50')).toEqual([
      { text: 'hi ' },
      { text: '$alice', mention: 'alice' },
      { text: ', that is ' },
      { text: '$50' },
    ]);
  });
  test('query and apply', () => {
    expect(mentionQuery('hey @al')).toBe('al');
    expect(mentionQuery('hey $')).toBe('');
    expect(mentionQuery('email a@b')).toBeNull();
    expect(applyMention('hey @al', 'alice')).toBe('hey $alice ');
  });
  test('suggests recent authors, not me or $b', () => {
    const ms = [msg({ author_handle: 'alice' }), msg({ author_handle: 'b' }), msg({ author_handle: 'albert' }), msg({ author_handle: 'me' })];
    expect(mentionSuggestions(ms, 'al', 'me')).toEqual(['albert', 'alice']);
  });
});

test('typing label', () => {
  expect(typingLabel([])).toBe('');
  expect(typingLabel(['alice'])).toBe('$alice is typing…');
  expect(typingLabel(['a', 'b'])).toBe('$a and $b are typing…');
  expect(typingLabel(['a', 'b', 'c'])).toBe('$a and 2 others are typing…');
});
