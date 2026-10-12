import { describe, expect, test } from 'bun:test';
import { evictionOrder, mergeThread, threadKey } from './threadCache';
import type { ChatMessage } from './messages';

const msg = (id: string, sec: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author_handle: 'a',
  kind: 'text',
  body: id,
  created_at: new Date(Date.UTC(2026, 9, 12, 0, 0, sec)).toISOString(),
  ...extra,
});

describe('mergeThread', () => {
  test('dedupes by id and keeps oldest-first order', () => {
    const out = mergeThread([msg('b', 2), msg('a', 1)], [msg('b', 2, { body: 'b2' }), msg('c', 3)]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(out[1].body).toBe('b2');
  });
  test('never stores optimistic, failed or ephemeral rows', () => {
    const out = mergeThread(
      [],
      [
        msg('local:1', 1, { pending: true, localId: '1' }),
        msg('x', 2, { failed: true }),
        msg('ephemeral:9', 3),
        msg('ok', 4),
      ],
    );
    expect(out.map((m) => m.id)).toEqual(['ok']);
    expect(out[0].pending).toBeUndefined();
  });
  test('an edit replaces the message it supersedes', () => {
    const out = mergeThread([msg('a', 1)], [msg('a2', 5, { supersedes_id: 'a', root_id: 'a' })]);
    expect(out.map((m) => m.id)).toEqual(['a2']);
  });
  test('caps at the newest `limit` messages', () => {
    const many = Array.from({ length: 70 }, (_, i) => msg(`m${String(i).padStart(2, '0')}`, i));
    const out = mergeThread([], many);
    expect(out.length).toBe(50);
    expect(out[0].id).toBe('m20');
    expect(mergeThread([], many, 5).map((m) => m.id)).toEqual(['m65', 'm66', 'm67', 'm68', 'm69']);
  });
});

describe('evictionOrder', () => {
  const e = (key: string, at: number, bytes: number) => ({ key, at, bytes });
  test('nothing to evict under the caps', () => {
    expect(evictionOrder([e('a', 1, 10), e('b', 2, 10)], 100, 5)).toEqual([]);
  });
  test('evicts the oldest rooms first until under the byte cap', () => {
    expect(evictionOrder([e('new', 9, 40), e('old', 1, 40), e('mid', 5, 40)], 80, 10)).toEqual(['old']);
    expect(evictionOrder([e('new', 9, 40), e('old', 1, 40), e('mid', 5, 40)], 40, 10)).toEqual(['old', 'mid']);
  });
  test('evicts past the room cap', () => {
    expect(evictionOrder([e('a', 3, 1), e('b', 1, 1), e('c', 2, 1)], 1000, 1)).toEqual(['b', 'c']);
  });
  test('keys are per identity and case-insensitive', () => {
    expect(threadKey('$Me', '$ROOM')).toBe(threadKey('me', 'room'));
    expect(threadKey('me', 'room')).not.toBe(threadKey('you', 'room'));
  });
});
