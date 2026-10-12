import { describe, expect, test } from 'bun:test';
import {
  Backoff,
  BACKOFF_MAX_MS,
  FALLBACK_MS,
  frameToEvent,
  LiveHub,
  OFF_RETRY_MS,
  pollMsFor,
  routeEvent,
  SseParser,
  ticketFrom,
  type LiveDeps,
  type LiveEvent,
  type TicketResult,
} from './live';
import type { Http } from './api';

describe('SseParser', () => {
  test('frames, comments, multi-line data and Last-Event-ID across chunks', () => {
    const p = new SseParser();
    expect(p.feed(': hb\n\n')).toEqual([]);
    expect(p.feed('id: 41\nevent: message.new\nda')).toEqual([]);
    const f = p.feed('ta: {"a":1}\ndata: x\n\n');
    expect(f).toEqual([{ id: '41', event: 'message.new', data: '{"a":1}\nx' }]);
    expect(p.lastEventId).toBe('41');
    expect(p.feed('data:no-space\r\n\r\n')).toEqual([{ data: 'no-space' }]);
    expect(p.lastEventId).toBe('41');
  });

  test('CR split across chunks and starting id', () => {
    const p = new SseParser('7');
    expect(p.lastEventId).toBe('7');
    expect(p.feed('id: 8\r')).toEqual([]);
    expect(p.feed('\ndata: y\r\n\r\n')).toEqual([{ id: '8', data: 'y' }]);
    expect(p.lastEventId).toBe('8');
  });

  test('frameToEvent reads the envelope, falls back to event name', () => {
    expect(
      frameToEvent({
        id: '9',
        data: JSON.stringify({ id: 9, type: 'message.new', room: 'LOUNGE', ts: 't', data: { ref: 'm1', actor: 'a' } }),
      }),
    ).toEqual({ id: '9', type: 'message.new', room: 'LOUNGE', ts: 't', data: { ref: 'm1', actor: 'a' } });
    expect(frameToEvent({ event: 'resync', data: '' })).toEqual({ type: 'resync' });
    expect(frameToEvent({ event: 'ready', data: 'ok' })).toEqual({ type: 'ready' });
    expect(frameToEvent({ data: 'not json' })).toBeNull();
  });
});

describe('routeEvent', () => {
  const r = (type: string) => routeEvent({ type });
  test('message-like events re-read the thread', () => {
    for (const t of ['message.new', 'message.edit', 'message.event', 'reaction', 'delete']) expect(r(t)).toBe('thread');
  });
  test('the rest', () => {
    expect(r('room.update')).toBe('list');
    expect(r('member.join')).toBe('list');
    expect(r('typing')).toBe('typing');
    expect(r('read')).toBe('read');
    expect(r('resync')).toBe('resync');
    expect(r('ready')).toBe('ready');
    expect(r('whatever')).toBeNull();
  });
  test('poll interval only stretches while live', () => {
    expect(pollMsFor('live', 4_000, 60_000)).toBe(60_000);
    expect(pollMsFor('fallback', 4_000, 60_000)).toBe(4_000);
    expect(pollMsFor('off', 30_000, 300_000)).toBe(30_000);
  });
});

describe('Backoff', () => {
  test('exponential with jitter, capped at 30 s, then fallback after 3 fails in 2 min', () => {
    const b = new Backoff(() => 1);
    expect(b.fail(0)).toEqual({ delay: 1_000, fallback: false });
    expect(b.fail(200_000)).toEqual({ delay: 2_000, fallback: false });
    expect(b.fail(400_000)).toEqual({ delay: 4_000, fallback: false });
    for (let i = 0; i < 5; i++) b.fail(600_000 + i * 200_000);
    expect(b.fail(2_000_000).delay).toBe(BACKOFF_MAX_MS);
    // Three inside the window → polling for 5 min.
    expect(b.fail(2_010_000).fallback).toBe(false);
    expect(b.fail(2_020_000)).toEqual({ delay: FALLBACK_MS, fallback: true });
    // ok() resets.
    b.ok();
    expect(b.fail(3_000_000)).toEqual({ delay: 1_000, fallback: false });
  });

  test('jitter stays in [base/2, base] and at least 1 s', () => {
    const b = new Backoff(() => 0);
    expect(b.fail(0).delay).toBe(1_000);
    expect(b.fail(500_000).delay).toBe(1_000);
    expect(b.fail(1_000_000).delay).toBe(2_000);
  });
});

describe('ticketFrom', () => {
  const http =
    (status: number, data: unknown): Http =>
    async () => ({ status, data });
  test('404 = live off; 2xx with ticket = ok; others = error', async () => {
    const s = () => ({ token: 't' });
    expect(await ticketFrom(http(404, { error: 'off' }), s)()).toEqual({ kind: 'off' });
    expect(await ticketFrom(http(200, { ticket: 'abc', expiresIn: 60 }), s)()).toEqual({ kind: 'ok', ticket: 'abc' });
    expect(await ticketFrom(http(401, {}), s)()).toEqual({ kind: 'error' });
    expect(await ticketFrom(http(200, {}), () => null)()).toEqual({ kind: 'error' });
  });
  test('sends the bChat Bearer session', async () => {
    let seen: Record<string, string> = {};
    const h: Http = async (req) => {
      seen = req.headers;
      return { status: 200, data: { ticket: 'x' } };
    };
    await ticketFrom(h, () => ({ token: 'sess' }))();
    expect(seen.Authorization).toBe('Bearer sess');
  });
});

/** A hub with fake timers and a scripted stream. */
const rig = (ticket: () => Promise<TicketResult>, chunks: string[] | (() => AsyncIterable<string>)) => {
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const opened: Record<string, string>[] = [];
  const deps: LiveDeps = {
    ticket,
    open: async (_url, headers) => {
      opened.push(headers);
      if (typeof chunks === 'function') return chunks();
      const list = chunks;
      return {
        async *[Symbol.asyncIterator]() {
          for (const c of list) yield c;
          // then hang (stream stays open) until aborted
          await new Promise(() => undefined);
        },
      };
    },
    enabled: async () => true,
    now: () => 0,
    setTimer: (fn, ms) => {
      const id = next++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearTimer: (t) => {
      const i = timers.findIndex((x) => x.id === t);
      if (i >= 0) timers.splice(i, 1);
    },
    random: () => 1,
    url: 'https://rt.test',
  };
  return { hub: new LiveHub(deps), timers, opened };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveHub', () => {
  test('404 ticket → off, polls continue, retries in 5 min', async () => {
    const { hub, timers } = rig(async () => ({ kind: 'off' }), []);
    hub.acquire();
    await tick();
    expect(hub.health).toBe('off');
    expect(hub.healthy).toBe(false);
    expect(timers.map((t) => t.ms)).toContain(OFF_RETRY_MS);
  });

  test('ready → live; events route to typed room listeners; Last-Event-ID kept', async () => {
    const env = (o: object) => `id: ${(o as { id: string }).id}\ndata: ${JSON.stringify(o)}\n\n`;
    const { hub, opened } = rig(
      async () => ({ kind: 'ok', ticket: 'T' }),
      [
        'event: ready\ndata: {}\n\n',
        env({ id: '5', type: 'message.new', room: 'A', data: { ref: 'm' } }),
        env({ id: '6', type: 'message.new', room: 'B' }),
        'event: resync\ndata: {}\n\n',
      ],
    );
    const a: LiveEvent[] = [];
    const any: LiveEvent[] = [];
    hub.on('message.new', 'A', (e) => a.push(e));
    hub.on('*', undefined, (e) => any.push(e));
    hub.acquire();
    await tick();
    await tick();
    expect(hub.health).toBe('live');
    expect(opened[0].Authorization).toBe('Bearer T');
    expect(opened[0]['Last-Event-ID']).toBeUndefined();
    expect(a.map((e) => e.id)).toEqual(['5']);
    expect(any.map((e) => e.type)).toEqual(['ready', 'message.new', 'message.new', 'resync']);
    expect(hub.lastEventId).toBe('6');
  });

  test('a dropped stream backs off, and resumes with Last-Event-ID', async () => {
    let n = 0;
    const { hub, timers, opened } = rig(
      async () => ({ kind: 'ok', ticket: 'T' }),
      () => ({
        async *[Symbol.asyncIterator]() {
          n++;
          yield `id: ${n}\ndata: {"type":"message.new","room":"A"}\n\n`;
        },
      }),
    );
    hub.acquire();
    await tick();
    await tick();
    expect(hub.health).toBe('backoff');
    const retry = timers.find((t) => t.ms === 1_000)!;
    retry.fn();
    await tick();
    await tick();
    expect(opened[1]['Last-Event-ID']).toBe('1');
  });

  test('three failures inside 2 min → fallback polling for 5 min', async () => {
    const { hub, timers } = rig(async () => ({ kind: 'error' }), []);
    hub.acquire();
    for (let i = 0; i < 2; i++) {
      await tick();
      timers.splice(0).forEach((t) => t.fn());
    }
    await tick();
    expect(hub.health).toBe('fallback');
    expect(timers.map((t) => t.ms)).toEqual([FALLBACK_MS]);
  });

  test('pause closes; release of the last user goes idle', async () => {
    const { hub } = rig(async () => ({ kind: 'ok', ticket: 'T' }), ['event: ready\ndata: {}\n\n']);
    const release = hub.acquire();
    await tick();
    await tick();
    expect(hub.health).toBe('live');
    hub.pause();
    expect(hub.health).toBe('idle');
    const seen: string[] = [];
    hub.on('resync', undefined, (e) => seen.push(e.type));
    hub.resume();
    expect(seen).toEqual(['resync']);
    release();
    expect(hub.health).toBe('idle');
  });
});
