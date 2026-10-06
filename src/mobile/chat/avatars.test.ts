import { describe, expect, test } from 'bun:test';
import { pendingBQuestions } from './avatars';

const now = Date.parse('2026-10-06T08:00:00Z');
const at = (sAgo: number) => new Date(now - sAgo * 1000).toISOString();
const msg = (id: string, author: string, body: string, sAgo: number, extra = {}) => ({ id, author_handle: author, body, created_at: at(sAgo), ...extra });

describe('pendingBQuestions', () => {
  test('a fresh /b question with no answer is waiting', () => {
    expect([...pendingBQuestions([msg('q', 'ann', '/b how do I send?', 5)], now)]).toEqual(['q']);
  });
  test('answered once $b replies to it', () => {
    const answer = msg('a', 'b', 'Here is how…', 2, { event_payload: { agent: 'b', reply_to: { id: 'q' } } });
    expect(pendingBQuestions([msg('q', 'ann', '/b how?', 5), answer], now).size).toBe(0);
  });
  test('bare /b counts; /bob and ordinary messages do not', () => {
    const got = pendingBQuestions([msg('1', 'a', '/b', 1), msg('2', 'a', '/bob hi', 1), msg('3', 'a', 'hello', 1)], now);
    expect([...got]).toEqual(['1']);
  });
  test('gives up after 90 seconds', () => {
    expect(pendingBQuestions([msg('q', 'ann', '/b hello?', 120)], now).size).toBe(0);
  });
  test('an optimistic (still sending) question is waiting', () => {
    expect(pendingBQuestions([msg('local:1', 'me', '/b hi', 0, { pending: true })], now).size).toBe(1);
  });
});
