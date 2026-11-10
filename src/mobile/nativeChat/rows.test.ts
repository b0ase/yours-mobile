import { describe, expect, test } from 'bun:test';
import { emptyPrefs, setMuted, setPinned } from '../chat/listPrefs';
import type { ChatMessage, ChatRoom } from '../chat/messages';
import { CARD_HINT, diffRows, roomCacheable, roomRows, SEALED_TEXT, threadRows, type NativeRow } from './rows';

const at = '2026-11-08T10:00:00.000Z';
const msg = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author_handle: 'alice',
  kind: 'text',
  body: `body ${id}`,
  created_at: at,
  ...over,
});
const now = new Date('2026-11-08T12:00:00.000Z');
const messageRows = (ms: ChatMessage[], me = 'bob') => threadRows(ms, me, { now }).filter((r) => r.type !== 'day');

describe('threadRows', () => {
  test('puts a day separator first and marks sender, mine and grouping', () => {
    const rows = threadRows(
      [msg('1'), msg('2'), msg('3', { author_handle: 'bob', created_at: '2026-11-08T10:01:00.000Z' })],
      'bob',
      { now },
    );
    expect(rows[0]).toMatchObject({ type: 'day', text: 'Today' });
    expect(rows[1]).toMatchObject({ id: '1', type: 'message', author: '$alice', mine: false, first: true });
    expect(rows[2]).toMatchObject({ id: '2', first: false });
    expect(rows[3]).toMatchObject({ id: '3', mine: true, author: undefined, bubble: undefined });
  });

  test('gives other people a tinted, never black, bubble', () => {
    const [r] = messageRows([msg('1')]);
    expect(r.bubble).toMatch(/^#[0-9a-f]{6}$/);
    expect(r.bubble).not.toBe('#000000');
    expect(r.nameColor).toMatch(/^#/);
  });

  test('system events and bot messages', () => {
    const rows = messageRows([
      msg('e', { kind: 'event', author_handle: null, body: '$a joined', event_type: 'join' }),
      msg('e2', { kind: 'event', author_handle: null, body: null, event_type: 'x' }),
      msg('bot', {
        kind: 'event',
        author_handle: null,
        event_type: 'bot_message',
        body: 'hi',
        event_payload: { name: 'Help Desk bot' },
      }),
    ]);
    expect(rows[0]).toMatchObject({ type: 'system', text: '$a joined' });
    expect(rows[1]).toMatchObject({ type: 'system', text: 'Room update' });
    expect(rows[2]).toMatchObject({ type: 'message', badge: 'BOT', author: 'Help Desk bot', text: 'hi' });
  });

  test('a sealed body never crosses the bridge, not even as ciphertext', () => {
    const rows = messageRows([
      msg('s', { body: 'e2ee1:SECRETENVELOPE' }),
      msg('t', { body: 'plain?', event_payload: { e2ee: true } }),
    ]);
    expect(rows[0].text).toBe(SEALED_TEXT);
    expect(rows[1].text).toBe(SEALED_TEXT);
    expect(JSON.stringify(rows)).not.toContain('SECRETENVELOPE');
  });

  test('sealed rooms are not cacheable', () => {
    const room = { metadata: null } as Pick<ChatRoom, 'metadata'>;
    expect(roomCacheable(room, [msg('1')])).toBe(true);
    expect(roomCacheable(room, [msg('1', { body: 'e2ee1:x' })])).toBe(false);
    expect(roomCacheable({ metadata: { e2ee: true } }, [])).toBe(false);
  });

  test('media and cards become a row that hands off to the full room', () => {
    const rows = messageRows([msg('m', { kind: 'media', event_payload: { media_id: 'x', filename: 'a.pdf' } })]);
    expect(rows[0]).toMatchObject({ type: 'card', text: 'Attachment: a.pdf' });
    expect(CARD_HINT.length).toBeGreaterThan(0);
  });

  test('blocked authors, reactions and hidden ids are dropped', () => {
    const ms = [
      msg('1', { author_handle: 'troll' }),
      msg('2', { kind: 'event', event_type: 'reaction', author_handle: 'a', body: null }),
      msg('3'),
      msg('4'),
    ];
    const rows = threadRows(ms, 'bob', { blocked: ['troll'], hidden: new Set(['4']), now }).filter(
      (r) => r.type !== 'day',
    );
    expect(rows.map((r) => r.id)).toEqual(['3']);
  });

  test('send state, retry id, reply quote and private $b', () => {
    const rows = messageRows([
      msg('p', { author_handle: 'bob', pending: true, localId: 'l1', id: 'local:l1' }),
      msg('f', { author_handle: 'bob', failed: true, localId: 'l2', id: 'local:l2' }),
      msg('r', { event_payload: { reply_to: { id: 'x', author: 'carol', snippet: 'hello' } } }),
      msg('b', { author_handle: 'b', event_payload: { agent_private: true } }),
    ]);
    expect(rows[0]).toMatchObject({ status: 'pending', id: 'local:l1', localId: undefined });
    expect(rows[1]).toMatchObject({ status: 'failed', localId: 'l2' });
    expect(rows[2]).toMatchObject({ quoteAuthor: '$carol', quoteText: 'hello' });
    expect(rows[3]).toMatchObject({ note: 'Only you can see this', variant: 'b' });
  });
});

describe('roomRows', () => {
  const room = (ticker: string, over: Partial<ChatRoom> = {}): ChatRoom => ({
    id: ticker,
    ticker,
    name: ticker,
    updated_at: at,
    ...over,
  });

  test('titles DMs by the other person and carries unread', () => {
    const [r] = roomRows([room('DM', { name: '$alice ↔ $bob', unread: 3 })], 'bob', emptyPrefs(), { now });
    expect(r).toMatchObject({ title: '$alice', unread: 3, direct: true, initial: 'A' });
  });

  test('pinned first, then newest; mute shows', () => {
    const rooms = [room('OLD', { updated_at: '2026-11-01T00:00:00Z' }), room('NEW')];
    const p = setMuted(setPinned(emptyPrefs(), 'OLD', true), 'NEW', true);
    const rows = roomRows(rooms, 'bob', p, { now });
    expect(rows.map((r) => r.ticker)).toEqual(['OLD', 'NEW']);
    expect(rows[0].pinned).toBe(true);
    expect(rows[1].muted).toBe(true);
  });

  test('a sealed last message previews as encrypted, not ciphertext', () => {
    const [r] = roomRows(
      [
        room('S', {
          last_message: {
            author_handle: 'alice',
            kind: 'text',
            body: 'e2ee1:SECRET',
            event_type: null,
            created_at: at,
          },
        }),
      ],
      'bob',
      emptyPrefs(),
      { now },
    );
    expect(r.preview).toBe(SEALED_TEXT);
  });
});

describe('diffRows', () => {
  const r = (id: string, text = id): NativeRow => ({ id, type: 'message', text });
  test('no change is null', () => expect(diffRows([r('a')], [r('a')])).toBeNull());
  test('append sends only the tail', () =>
    expect(diffRows([r('a')], [r('a'), r('b')])).toEqual({ from: 1, rows: [r('b')] }));
  test('a changed row resends from there', () =>
    expect(diffRows([r('a'), r('b')], [r('a'), r('b', 'x')])).toEqual({ from: 1, rows: [r('b', 'x')] }));
  test('prepending is a whole-list change', () =>
    expect(diffRows([r('b')], [r('a'), r('b')])).toEqual({ from: 0, rows: [r('a'), r('b')] }));
  test('a shorter list says where it ends', () =>
    expect(diffRows([r('a'), r('b')], [r('a')])).toEqual({ from: 1, rows: [] }));
});
