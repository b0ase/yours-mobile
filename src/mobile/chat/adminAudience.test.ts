import { describe, expect, test } from 'bun:test';
import { ADMIN_AUDIENCE, visibleMessages } from './messages';

const rows = [
  { id: 'a', event_payload: null },
  { id: 'b', event_payload: { audience: ADMIN_AUDIENCE, text: 'left — no longer holds the gate token' } },
  { id: 'c', event_payload: { audience: 'everyone' } },
  { id: 'd' },
];

describe('admin-only room events', () => {
  test('hidden from members', () => {
    expect(visibleMessages(rows, false).map((m) => m.id)).toEqual(['a', 'c', 'd']);
  });
  test('shown to the room admin / issuer', () => {
    expect(visibleMessages(rows, true).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
