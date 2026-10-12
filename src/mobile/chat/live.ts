/**
 * Live chat (P2/P3): one Server-Sent Events stream per app from the rt relay (bit-sign
 * ops/rt-relay). The relay carries ids only, `{id, type, room, ts, data: {ref, actor}}`; on a
 * message event the caller re-reads that room through the normal `since` path, so membership,
 * history floors and redaction stay on bit-sign.
 *
 * - Ticket: `POST https://www.bit-sign.online/api/bitsign/rt/ticket` with the bChat Bearer session.
 *   404 = live chat is off on the server: poll as before and ask again in 5 minutes.
 * - Stream: fetch streaming (not EventSource) so the Authorization and Last-Event-ID headers work in
 *   Capacitor and extension pages. Never in the MV3 service worker (no `document` there).
 * - Reconnect: backoff 1 s → 30 s with jitter; 3 failures inside 2 min → polling for 5 min.
 * - Capacitor: the stream closes in the background and resumes with Last-Event-ID, then a resync.
 * - Off switch: build constant VITE_LIVE_CHAT=0, or remote config `features.liveChat: false`.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { useEffect, useRef, useState } from 'react';
import { defaultHttp, loadSession, type Http } from './api';
import { getRemoteConfig } from '../config/remoteConfig';

export const RT_URL: string = (import.meta.env.VITE_RT_URL as string | undefined) || 'https://rt.b0ase.com';
export const TICKET_URL = 'https://www.bit-sign.online/api/bitsign/rt/ticket';
/** Build-time kill switch: VITE_LIVE_CHAT=0 builds a wallet that never opens the stream. */
export const LIVE_BUILD: boolean = import.meta.env.VITE_LIVE_CHAT !== '0';

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const FAIL_WINDOW_MS = 120_000;
export const FAIL_LIMIT = 3;
export const FALLBACK_MS = 300_000;
export const OFF_RETRY_MS = 300_000;
/** Heartbeats come every 25 s; nothing for this long means the stream is dead. */
export const SILENCE_MS = 60_000;

export type LiveType =
  | 'message.new'
  | 'message.edit'
  | 'message.event'
  | 'reaction'
  | 'delete'
  | 'typing'
  | 'read'
  | 'room.update'
  | 'member.join'
  | 'member.leave'
  | 'member.update'
  | 'resync'
  | 'ready';

export type LiveEvent = {
  id?: string;
  type: string;
  room?: string;
  ts?: string;
  data?: { ref?: string; actor?: string };
};

// ───────────────────────────── SSE frame parser ─────────────────────────────

export type SseFrame = { id?: string; event?: string; data: string };

/**
 * Incremental text/event-stream parser (WHATWG rules: `field: value`, blank line ends a frame,
 * `:` comments ignored, CR/LF/CRLF). `lastEventId` follows every `id:` line, as EventSource does.
 */
export class SseParser {
  lastEventId: string;
  private buf = '';
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];

  constructor(lastEventId = '') {
    this.lastEventId = lastEventId;
  }

  feed(chunk: string): SseFrame[] {
    this.buf += chunk;
    const out: SseFrame[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone CR at the end may be the first half of CRLF: wait for more.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const f = this.line(line);
      if (f) out.push(f);
    }
    return out;
  }

  private line(line: string): SseFrame | null {
    if (line === '') {
      const had = this.data.length > 0 || this.event !== undefined;
      const frame: SseFrame = { data: this.data.join('\n') };
      if (this.id !== undefined) frame.id = this.id;
      if (this.event !== undefined) frame.event = this.event;
      this.id = undefined;
      this.event = undefined;
      this.data = [];
      return had ? frame : null;
    }
    if (line.startsWith(':')) return null;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) {
      this.id = value;
      this.lastEventId = value;
    }
    return null;
  }
}

/** A frame as a relay event; null for frames that are not (bad JSON, empty). */
export const frameToEvent = (f: SseFrame): LiveEvent | null => {
  let body: Partial<LiveEvent> = {};
  if (f.data) {
    try {
      const v = JSON.parse(f.data) as unknown;
      if (v && typeof v === 'object') body = v as Partial<LiveEvent>;
    } catch {
      if (!f.event) return null;
    }
  }
  const type = typeof body.type === 'string' && body.type ? body.type : f.event;
  if (!type) return null;
  const ev: LiveEvent = { type };
  const id = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id) : f.id;
  if (id) ev.id = id;
  if (typeof body.room === 'string') ev.room = body.room;
  if (typeof body.ts === 'string') ev.ts = body.ts;
  if (body.data && typeof body.data === 'object') ev.data = body.data;
  return ev;
};

// ───────────────────────────── Routing ─────────────────────────────

/** What a client does with an event. */
export type LiveAction = 'thread' | 'list' | 'typing' | 'read' | 'resync' | 'ready' | null;

export const routeEvent = (ev: LiveEvent): LiveAction => {
  switch (ev.type) {
    case 'message.new':
    case 'message.edit':
    case 'message.event':
    case 'reaction':
    case 'delete':
      return 'thread';
    case 'room.update':
    case 'member.join':
    case 'member.leave':
    case 'member.update':
      return 'list';
    case 'typing':
      return 'typing';
    case 'read':
      return 'read';
    case 'resync':
      return 'resync';
    case 'ready':
      return 'ready';
    default:
      return null;
  }
};

/** Event types that mean "this room's messages changed: re-read with since". */
export const THREAD_TYPES: LiveType[] = ['message.new', 'message.edit', 'message.event', 'reaction', 'delete'];
/** Event types that change the chat list (last message, unread, names, members). */
export const LIST_TYPES: LiveType[] = [
  ...THREAD_TYPES,
  'room.update',
  'member.join',
  'member.leave',
  'member.update',
  'read',
];

// ───────────────────────────── Backoff / fallback ─────────────────────────────

/**
 * The reconnect state machine, pure so it is tested without timers. `fail(now)` returns how long to
 * wait and whether that wait is the 5-minute polling fallback.
 */
export class Backoff {
  private attempt = 0;
  private failures: number[] = [];
  constructor(private readonly random: () => number = Math.random) {}

  fail(now: number): { delay: number; fallback: boolean } {
    this.failures = this.failures.filter((t) => now - t < FAIL_WINDOW_MS).concat(now);
    if (this.failures.length >= FAIL_LIMIT) {
      this.failures = [];
      this.attempt = 0;
      return { delay: FALLBACK_MS, fallback: true };
    }
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    this.attempt++;
    // Jitter in [base/2, base], never under the minimum.
    const delay = Math.max(BACKOFF_MIN_MS, Math.round(base / 2 + (base / 2) * this.random()));
    return { delay, fallback: false };
  }

  /** The stream reached `ready`: start again from 1 s. */
  ok(): void {
    this.attempt = 0;
    this.failures = [];
  }
}

// ───────────────────────────── Hub ─────────────────────────────

export type LiveHealth = 'idle' | 'connecting' | 'live' | 'backoff' | 'fallback' | 'off';

export type TicketResult = { kind: 'ok'; ticket: string } | { kind: 'off' } | { kind: 'error' };

export type LiveDeps = {
  ticket: () => Promise<TicketResult>;
  /** Opens the stream; resolves with a reader of text chunks. Throws on a non-2xx. */
  open: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<AsyncIterable<string>>;
  enabled: () => Promise<boolean>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  random: () => number;
  url: string;
};

export const ticketFrom =
  (http: Http, session: () => { token: string } | null, url = TICKET_URL) =>
  async (): Promise<TicketResult> => {
    const s = session();
    if (!s) return { kind: 'error' };
    try {
      const r = await http({ method: 'POST', url, headers: { Authorization: `Bearer ${s.token}` }, body: {} });
      if (r.status === 404) return { kind: 'off' };
      const t = (r.data as { ticket?: unknown } | null)?.ticket;
      if (r.status >= 200 && r.status < 300 && typeof t === 'string' && t) return { kind: 'ok', ticket: t };
      return { kind: 'error' };
    } catch {
      return { kind: 'error' };
    }
  };

const fetchOpen: LiveDeps['open'] = async (url, headers, signal) => {
  const res = await fetch(url, { headers, signal, credentials: 'omit', cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`rt ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield dec.decode(value, { stream: true });
      }
    },
  };
};

type Listener = { type: string; room?: string; cb: (ev: LiveEvent) => void };

export class LiveHub {
  health: LiveHealth = 'idle';
  lastEventId = '';
  private listeners = new Set<Listener>();
  private healthListeners = new Set<(h: LiveHealth) => void>();
  private users = 0;
  private paused = false;
  private abort: AbortController | null = null;
  private timer: unknown = null;
  private silence: unknown = null;
  private backoff: Backoff;
  private gen = 0;

  constructor(private readonly deps: LiveDeps) {
    this.backoff = new Backoff(deps.random);
  }

  /** Typed listener; `room` limits it to one room. `'*'` hears every type. Returns an unsubscribe. */
  on(type: LiveType | '*', room: string | undefined, cb: (ev: LiveEvent) => void): () => void {
    const l: Listener = { type, room, cb };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onHealth(cb: (h: LiveHealth) => void): () => void {
    this.healthListeners.add(cb);
    return () => this.healthListeners.delete(cb);
  }

  get healthy() {
    return this.health === 'live';
  }

  /** A UI page wants the stream; the last release closes it. */
  acquire(): () => void {
    this.users++;
    if (this.users === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.users--;
      if (this.users === 0) this.stop('idle');
    };
  }

  /** App went to the background: close, keep Last-Event-ID. */
  pause() {
    this.paused = true;
    this.stop('idle');
  }

  /** Back in the foreground: reconnect at once (Last-Event-ID), then everyone refreshes. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.users > 0) {
      this.backoff.ok();
      this.start();
      this.emit({ type: 'resync' });
    }
  }

  private setHealth(h: LiveHealth) {
    if (this.health === h) return;
    this.health = h;
    for (const cb of this.healthListeners) cb(h);
  }

  private emit(ev: LiveEvent) {
    for (const l of [...this.listeners]) {
      if (l.type !== '*' && l.type !== ev.type) continue;
      // resync reaches every room's listener; room events only that room (or room-less listeners).
      if (l.room && ev.type !== 'resync' && ev.room !== l.room) continue;
      try {
        l.cb(ev);
      } catch {
        /* a listener's bug never kills the stream */
      }
    }
  }

  private clearTimers() {
    if (this.timer) this.deps.clearTimer(this.timer);
    if (this.silence) this.deps.clearTimer(this.silence);
    this.timer = null;
    this.silence = null;
  }

  private stop(h: LiveHealth) {
    this.gen++;
    this.clearTimers();
    this.abort?.abort();
    this.abort = null;
    this.setHealth(h);
  }

  private start() {
    if (this.paused || this.users === 0) return;
    this.stop('connecting');
    const gen = this.gen;
    void this.connect(gen);
  }

  private later(ms: number, h: LiveHealth) {
    this.setHealth(h);
    this.clearTimers();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.start();
    }, ms);
  }

  private failed(gen: number) {
    if (gen !== this.gen) return;
    this.abort?.abort();
    this.abort = null;
    const { delay, fallback } = this.backoff.fail(this.deps.now());
    this.later(delay, fallback ? 'fallback' : 'backoff');
  }

  private armSilence(gen: number) {
    if (this.silence) this.deps.clearTimer(this.silence);
    this.silence = this.deps.setTimer(() => {
      this.silence = null;
      this.failed(gen);
    }, SILENCE_MS);
  }

  private async connect(gen: number) {
    if (!(await this.deps.enabled().catch(() => false))) {
      if (gen === this.gen) this.later(OFF_RETRY_MS, 'off');
      return;
    }
    const t = await this.deps.ticket();
    if (gen !== this.gen) return;
    if (t.kind === 'off') return this.later(OFF_RETRY_MS, 'off');
    if (t.kind === 'error') return this.failed(gen);
    const abort = new AbortController();
    this.abort = abort;
    const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${t.ticket}` };
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const parser = new SseParser(this.lastEventId);
    try {
      const stream = await this.deps.open(`${this.deps.url}/events`, headers, abort.signal);
      if (gen !== this.gen) return;
      this.armSilence(gen);
      for await (const chunk of stream) {
        if (gen !== this.gen) return;
        this.armSilence(gen);
        for (const f of parser.feed(chunk)) {
          if (parser.lastEventId) this.lastEventId = parser.lastEventId;
          const ev = frameToEvent(f);
          if (!ev) continue;
          if (ev.type === 'ready') {
            this.backoff.ok();
            this.setHealth('live');
          }
          this.emit(ev);
        }
      }
      // The server closed the stream.
      this.failed(gen);
    } catch {
      this.failed(gen);
    }
  }
}

// ───────────────────────────── App singleton ─────────────────────────────

/** UI pages only: the MV3 service worker has no document and must never hold the stream. */
const isUiPage = () => typeof window !== 'undefined' && typeof document !== 'undefined';

let hub: LiveHub | null = null;

export const liveHub = (): LiveHub | null => {
  if (!LIVE_BUILD || !isUiPage()) return null;
  if (hub) return hub;
  hub = new LiveHub({
    ticket: ticketFrom(defaultHttp(Capacitor.isNativePlatform()), () => loadSession()),
    open: fetchOpen,
    enabled: async () => (await getRemoteConfig()).features.liveChat,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    random: Math.random,
    url: RT_URL,
  });
  const h = hub;
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => (isActive ? h.resume() : h.pause())).catch(
      () => undefined,
    );
  }
  return hub;
};

/** The hub's health, as React state (stays 'idle' where there is no hub). */
export const useLiveHealth = (): LiveHealth => {
  const [h, setH] = useState<LiveHealth>(() => liveHub()?.health ?? 'idle');
  useEffect(() => {
    const lh = liveHub();
    if (!lh) return;
    setH(lh.health);
    return lh.onHealth(setH);
  }, []);
  return h;
};

/** The poll interval to use: `liveMs` while the stream is healthy, else today's `fallbackMs`. */
export const pollMsFor = (health: LiveHealth, fallbackMs: number, liveMs: number) =>
  health === 'live' ? Math.max(liveMs, fallbackMs) : fallbackMs;

/**
 * Keep the stream open while mounted and call `fn` (coalesced to one call per 250 ms) on any of
 * `types` (for `room`, or any room) plus resync. Returns the poll interval the caller should use.
 */
export const useLive = (
  fn: (ev: LiveEvent) => void,
  fallbackMs: number,
  opts: { liveMs: number; types: LiveType[]; room?: string; enabled?: boolean },
): number => {
  const ref = useRef(fn);
  ref.current = fn;
  const health = useLiveHealth();
  const enabled = opts.enabled ?? true;
  const key = opts.types.join(',');
  const room = opts.room;
  useEffect(() => {
    const lh = liveHub();
    if (!lh || !enabled) return;
    const release = lh.acquire();
    let t: ReturnType<typeof setTimeout> | null = null;
    let lastEv: LiveEvent | null = null;
    const fire = (ev: LiveEvent) => {
      lastEv = ev;
      if (t) return;
      t = setTimeout(() => {
        t = null;
        if (lastEv) ref.current(lastEv);
      }, 250);
    };
    const offs = [...key.split(',').map((ty) => lh.on(ty as LiveType, room, fire)), lh.on('resync', room, fire)];
    return () => {
      if (t) clearTimeout(t);
      offs.forEach((o) => o());
      release();
    };
  }, [key, room, enabled]);
  return enabled ? pollMsFor(health, fallbackMs, opts.liveMs) : fallbackMs;
};

/** Typing over the stream: who is typing in `room` (each actor shown 6 s after their last ping). */
export const useLiveTyping = (room: string, me: string, enabled: boolean): string[] => {
  const [typing, setTyping] = useState<string[]>([]);
  useEffect(() => {
    const lh = liveHub();
    if (!lh || !enabled) return;
    const until = new Map<string, number>();
    const norm = (h: string) => h.replace(/^\$/, '').toLowerCase();
    const flush = () => {
      const now = Date.now();
      for (const [k, v] of until) if (v <= now) until.delete(k);
      setTyping([...until.keys()]);
    };
    const off = lh.on('typing', room, (ev) => {
      const actor = ev.data?.actor;
      if (!actor || norm(actor) === norm(me)) return;
      until.set(actor, Date.now() + 6_000);
      flush();
    });
    const id = setInterval(flush, 1_000);
    return () => {
      off();
      clearInterval(id);
    };
  }, [room, me, enabled]);
  return typing;
};
