import { describe, expect, test } from 'bun:test';
import { ChatApiError } from '../chat/api';
import type { ChatMessage, ChatRoom } from '../chat/messages';
import { CLOSED_NOTE, NativeRoomSession, PRICED_NOTE, type RoomSessionDeps, type RoomUpdate } from './roomSession';

const m = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author_handle: 'alice',
  kind: 'text',
  body: `b${id}`,
  created_at: `2026-11-08T10:0${id}:00.000Z`,
  ...over,
});
const room: ChatRoom = { id: 'r', ticker: 'ROOM', name: 'Room' };

const setup = (over: Partial<RoomSessionDeps> = {}, cached: ChatMessage[] | null = null) => {
  const updates: RoomUpdate[] = [];
  const sent: { body: string; spend: unknown }[] = [];
  let classic = 0;
  const deps: RoomSessionDeps = {
    client: {
      latestPage: async () => ({ messages: [m('1')], hasMore: true }),
      since: async () => [],
      page: async () => ({ messages: [], hasMore: false }),
      send: async (_t: string, body: string, spend?: unknown) => {
        sent.push({ body, spend });
        return m('9', { author_handle: 'bob', body });
      },
      markRead: async () => undefined,
    } as unknown as RoomSessionDeps['client'],
    me: 'bob',
    room,
    viewerIsAdmin: false,
    cache: { peek: () => cached, read: async () => cached, write: () => undefined },
    blocked: () => [],
    emit: (u) => updates.push(u),
    onAuthLost: () => undefined,
    onLocked: () => undefined,
    onClassic: () => {
      classic += 1;
    },
    ...over,
  };
  return { s: new NativeRoomSession(deps), updates, sent, classicCount: () => classic };
};
const last = (u: RoomUpdate[]) => u[u.length - 1];
const ids = (u: RoomUpdate) => u.rows.filter((r) => r.type === 'message').map((r) => r.id);

describe('NativeRoomSession', () => {
  test('cached tail shows first, without waiting for the network', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { s, updates } = setup(
      {
        client: {
          since: async () => {
            await gate;
            return [m('2')];
          },
          markRead: async () => undefined,
        } as unknown as RoomSessionDeps['client'],
      },
      [m('1')],
    );
    const opening = s.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(ids(updates[0])).toEqual(['1']);
    expect(updates[0].loading).toBe(false);
    release();
    await opening;
    expect(ids(last(updates))).toEqual(['1', '2']);
  });

  test('cold room loads the latest page', async () => {
    const { s, updates } = setup();
    await s.open();
    expect(updates[0].loading).toBe(true);
    expect(ids(last(updates))).toEqual(['1']);
    expect(last(updates).hasMore).toBe(true);
  });

  test('send shows pending, then the server row; through client.send with no spend', async () => {
    const { s, updates, sent } = setup({}, [m('1')]);
    await s.open();
    await s.send('  hello  ');
    expect(updates.some((u) => u.rows.some((r) => r.status === 'pending'))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ body: 'hello', spend: undefined }]);
    expect(last(updates).rows.some((r) => r.status === 'pending')).toBe(false);
    expect(ids(last(updates))).toEqual(['1', '9']);
  });

  test('a priced room never posts: composer sends you to the full room', async () => {
    const { s, updates, sent } = setup({ charge: async () => ({ exempt: false, charges: [{}] }) as never }, [m('1')]);
    await s.open();
    await s.send('hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
    expect(last(updates).composer).toEqual({ kind: 'classic', note: PRICED_NOTE });
  });

  test('a send waits for the price before deciding', async () => {
    let price = (_: unknown) => {};
    const pending = new Promise((r) => (price = r));
    const { s, sent } = setup({ charge: () => pending as never }, [m('1')]);
    await s.open();
    const sending = s.send('hi');
    await Promise.resolve();
    expect(sent).toEqual([]);
    price({ exempt: false, charges: [{}] });
    await sending;
    expect(sent).toEqual([]);
  });

  test('a 402 fails the row and moves posting to the full room, nothing spent', async () => {
    const client = {
      since: async () => [],
      markRead: async () => undefined,
      send: async () => {
        throw new ChatApiError('pay', 402);
      },
    } as unknown as RoomSessionDeps['client'];
    const { s, updates } = setup({ client }, [m('1')]);
    await s.open();
    await s.send('hi');
    await new Promise((r) => setTimeout(r, 0));
    expect(last(updates).rows.some((r) => r.status === 'failed')).toBe(true);
    expect(last(updates).composer.kind).toBe('classic');
  });

  test('closed rooms are read-only', async () => {
    const { s, updates, sent } = setup(
      { room: { ...room, metadata: { kind: 'open', open: { closed_at: '2026-11-01T00:00:00Z' } } } },
      [m('1')],
    );
    await s.open();
    await s.send('hi');
    expect(sent).toEqual([]);
    expect(last(updates).composer).toEqual({ kind: 'readonly', note: CLOSED_NOTE });
  });

  test('/commission goes to the full room and is never posted', async () => {
    const { s, sent, classicCount } = setup({}, [m('1')]);
    await s.open();
    await s.send('/commission');
    expect(sent).toEqual([]);
    expect(classicCount()).toBe(1);
  });

  test('a 403 gate refusal locks; a 401 reports auth lost', async () => {
    let locked = 0;
    let auth = 0;
    const refusing = (status: number, data: unknown) =>
      ({
        latestPage: async () => {
          throw new ChatApiError('no', status, data);
        },
      }) as unknown as RoomSessionDeps['client'];
    const gateData = {
      token_gated: true,
      error: 'x',
      gate: { key: `bsv21:${'a'.repeat(64)}_0`, symbol: 'A', dec: 0, minAmountRaw: '1' },
      held_raw: '0',
    };
    await setup({ client: refusing(403, gateData), onLocked: () => (locked += 1) }).s.open();
    await setup({ client: refusing(401, {}), onAuthLost: () => (auth += 1) }).s.open();
    expect(auth).toBe(1);
    expect(locked).toBe(1);
  });

  test('older pages prepend and report the start', async () => {
    const client = {
      since: async () => [],
      markRead: async () => undefined,
      page: async () => ({ messages: [m('0')], hasMore: false }),
    } as unknown as RoomSessionDeps['client'];
    const { s, updates } = setup({ client }, [m('1')]);
    await s.open();
    await s.older();
    expect(ids(last(updates))).toEqual(['0', '1']);
    expect(last(updates).rows[0]).toMatchObject({ id: 'note:start', type: 'system' });
    expect(last(updates).hasMore).toBe(false);
  });

  test('nothing is published after close', async () => {
    const { s, updates } = setup({}, [m('1')]);
    await s.open();
    const n = updates.length;
    s.close();
    await s.send('hi');
    expect(updates.length).toBe(n);
  });
});
