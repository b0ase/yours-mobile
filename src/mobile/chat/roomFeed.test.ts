import { describe, expect, test } from 'bun:test';

import {
  RoomFeed,
  credsFrom,
  feedRowWantsPoll,
  filterFor,
  pickRooms,
  rowFromFrame,
  socketUrl,
  MAX_ROOMS,
  type FeedRow,
  type FeedSocket,
} from './roomFeed';

const creds = { token: 'scoped-jwt', url: 'https://db.example.test', anonKey: 'anon', expiresAt: 10_000_000 };

const frame = (record: Record<string, unknown>) =>
  JSON.stringify({
    topic: 'realtime:wallet-rooms',
    event: 'postgres_changes',
    payload: { data: { type: 'INSERT', table: 'ticker_room_messages', record } },
  });

const harness = () => {
  const sockets: (FeedSocket & { sent: string[]; closed: boolean; url: string })[] = [];
  const feed = new RoomFeed({
    creds: async () => creds,
    socket: (url) => {
      const s = {
        url,
        sent: [] as string[],
        closed: false,
        send(d: string) {
          this.sent.push(d);
        },
        close() {
          this.closed = true;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as FeedSocket & { sent: string[]; closed: boolean; url: string };
      sockets.push(s);
      return s;
    },
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    setInterval: () => 2,
    clearInterval: () => {},
    random: () => 0.5,
  });
  return { feed, sockets };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('room feed', () => {
  test('an event row ("$mike joined.") reaches listeners and triggers the notify poll', async () => {
    const { feed, sockets } = harness();
    feed.setRooms(['room-a', 'room-b']);
    const release = feed.acquire();
    await flush();
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    const join = JSON.parse(sockets[0].sent[0]);
    expect(join.event).toBe('phx_join');
    expect(join.payload.access_token).toBe('scoped-jwt');
    expect(join.payload.config.postgres_changes[0]).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'ticker_room_messages',
      filter: 'room_id=in.(room-a,room-b)',
    });

    const polls: string[] = [];
    const tickers = new Map([['room-a', 'MIKE']]);
    feed.on(undefined, (row) => {
      if (
        feedRowWantsPoll(
          row,
          (id) => tickers.get(id),
          () => false,
        )
      )
        polls.push(row.room_id);
    });
    sockets[0].onmessage?.({
      data: frame({ room_id: 'room-a', kind: 'event', event_type: 'member_joined', body: '$mike joined.' }),
    });
    sockets[0].onmessage?.({ data: frame({ room_id: 'room-a', kind: 'text', body: 'hi' }) });
    expect(polls).toEqual(['room-a', 'room-a']);
    release();
    expect(sockets[0].closed).toBe(true);
  });

  test('muted or unknown rooms do not poll', () => {
    const row: FeedRow = { room_id: 'r1', kind: 'event' };
    expect(
      feedRowWantsPoll(
        row,
        () => 'T',
        () => true,
      ),
    ).toBe(false);
    expect(
      feedRowWantsPoll(
        row,
        () => undefined,
        () => false,
      ),
    ).toBe(false);
    expect(
      feedRowWantsPoll(
        row,
        () => 'T',
        () => false,
      ),
    ).toBe(true);
  });

  test('room listeners only hear their room', async () => {
    const { feed, sockets } = harness();
    const release = feed.acquire();
    await flush();
    const unpin = feed.pin('open-room');
    sockets[0].onopen?.();
    const got: string[] = [];
    feed.on('open-room', (r) => got.push(r.room_id));
    sockets[0].onmessage?.({ data: frame({ room_id: 'other' }) });
    sockets[0].onmessage?.({ data: frame({ room_id: 'open-room' }) });
    expect(got).toEqual(['open-room']);
    unpin();
    release();
  });

  test('background closes the one socket; foreground reopens it', async () => {
    const { feed, sockets } = harness();
    feed.acquire();
    await flush();
    feed.setForeground(false);
    expect(sockets[0].closed).toBe(true);
    expect(feed.open).toBe(false);
    feed.setForeground(true);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  test('room set is capped, pinned rooms first, bad ids dropped', () => {
    const many = Array.from({ length: 150 }, (_, i) => `r${i}`);
    const ids = pickRooms(many, ['open', 'bad id)']);
    expect(ids).toHaveLength(MAX_ROOMS);
    expect(ids[0]).toBe('open');
    expect(ids).not.toContain('bad id)');
    expect(filterFor(['a', 'b'])).toBe('room_id=in.(a,b)');
  });

  test('frame parsing and socket url', () => {
    expect(rowFromFrame('{"event":"phx_reply"}')).toBeNull();
    expect(rowFromFrame('not json')).toBeNull();
    expect(rowFromFrame(frame({ room_id: 'x', kind: 'event' }))?.kind).toBe('event');
    expect(socketUrl(creds)).toBe('wss://db.example.test/realtime/v1/websocket?apikey=anon&vsn=1.0.0');
  });

  test('creds come from the realtime-token endpoint with the bChat Bearer', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const get = credsFrom(
      async (req) => {
        seen = req;
        return { status: 200, data: creds };
      },
      () => ({ token: 'sess' }),
    );
    expect(await get()).toEqual(creds);
    expect(seen!.headers.Authorization).toBe('Bearer sess');
    expect(seen!.url).toContain('/api/bitsign/realtime-token');
    expect(
      await credsFrom(
        async () => ({ status: 401, data: null }),
        () => ({ token: 's' }),
      )(),
    ).toBeNull();
    expect(
      await credsFrom(
        async () => ({ status: 200, data: creds }),
        () => null,
      )(),
    ).toBeNull();
  });
});
