/**
 * Room feed: the same Supabase Realtime `postgres_changes` feed bChatX web uses (bit-sign
 * src/lib/realtime.ts), so a room insert reaches the wallet in about a second. bit-sign writes a
 * join as a `ticker_room_messages` row ({kind:'event', event_type:'member_joined'}) and never
 * publishes it to the rt relay (chat/live.ts), which is why "$mike joined" used to wait for the
 * 90 s notify poll.
 *
 * - Auth: GET <bChat origin>/api/bitsign/realtime-token with the bChat Bearer session. It returns a
 *   15-minute JWT scoped to the user's handle (RLS `room_member_read` delivers only rooms the user
 *   is in) plus the public url + anon key. Nothing is hard-coded here; the token is refreshed a
 *   minute before it expires.
 * - One WebSocket (Phoenix protocol, no SDK), one channel: INSERT on ticker_room_messages filtered
 *   to `room_id=in.(…)` for at most MAX_ROOMS rooms (most recent first; the open room always kept).
 * - Foreground only: open while someone holds it and the app is visible/active; closed otherwise.
 * - Rows are only a nudge: listeners re-read through the normal API (poll), so membership,
 *   redaction and unread counts stay on bit-sign. Every failure leaves the existing polling as is.
 */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { useEffect, useRef } from 'react';
import { BCHAT_ORIGIN, defaultHttp, loadSession, type Http } from './api';
import { Backoff } from './live';

export const MAX_ROOMS = 100; // Supabase `in` filters take up to 100 values.
export const HEARTBEAT_MS = 25_000;
export const TOKEN_URL = `${BCHAT_ORIGIN}/api/bitsign/realtime-token`;
const TOPIC = 'realtime:wallet-rooms';

export type FeedCreds = { token: string; url: string; anonKey: string; expiresAt: number };
export type FeedRow = { id?: string; room_id: string; kind?: string; event_type?: string | null };

export interface FeedSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type FeedDeps = {
  creds: () => Promise<FeedCreds | null>;
  socket: (url: string) => FeedSocket;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
  random: () => number;
};

export const credsFrom =
  (http: Http, session: () => { token: string } | null, url = TOKEN_URL) =>
  async (): Promise<FeedCreds | null> => {
    const s = session();
    if (!s) return null;
    try {
      const r = await http({ method: 'GET', url, headers: { Authorization: `Bearer ${s.token}` } });
      const d = r.data as Partial<Record<keyof FeedCreds, unknown>> | null;
      if (r.status < 200 || r.status >= 300 || !d) return null;
      if (typeof d.token !== 'string' || typeof d.url !== 'string' || typeof d.anonKey !== 'string') return null;
      if (!d.token || !d.url || !d.anonKey) return null;
      const exp = Number(d.expiresAt);
      return { token: d.token, url: d.url, anonKey: d.anonKey, expiresAt: exp > 0 ? exp : Date.now() + 15 * 60_000 };
    } catch {
      return null;
    }
  };

/** The rooms to watch: the pinned (open) rooms first, then the rest in the order given, capped. */
export const pickRooms = (rooms: string[], pinned: string[], max = MAX_ROOMS): string[] => {
  const ok = (id: string) => /^[A-Za-z0-9_-]+$/.test(id); // uuids; never let a value break the filter
  return [...new Set([...pinned, ...rooms].filter(ok))].slice(0, max);
};

export const filterFor = (ids: string[]) => `room_id=in.(${ids.join(',')})`;

export const socketUrl = (c: FeedCreds) =>
  `${c.url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(c.anonKey)}&vsn=1.0.0`;

/** An inserted row from a Phoenix frame, or null for anything else (replies, heartbeats, bad JSON). */
export const rowFromFrame = (raw: unknown): FeedRow | null => {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw) as { event?: string; payload?: { data?: { type?: string; record?: unknown } } };
    if (m.event !== 'postgres_changes') return null;
    const d = m.payload?.data;
    const rec = d?.record as FeedRow | undefined;
    if (d?.type !== 'INSERT' || !rec || typeof rec.room_id !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
};

/**
 * A row from the realtime room feed (chat/roomFeed.ts): any insert in a known, unmuted room —
 * a message or a kind:'event' row such as "$mike joined." — asks for a poll now. Used by notify/engine.ts; pure for tests.
 */
export const feedRowWantsPoll = (
  row: FeedRow,
  tickerOf: (roomId: string) => string | undefined,
  muted: (ticker: string) => boolean,
): boolean => {
  const ticker = tickerOf(row.room_id);
  return !!ticker && !muted(ticker);
};

type Listener = { room?: string; cb: (row: FeedRow) => void };

export class RoomFeed {
  private listeners = new Set<Listener>();
  private users = 0;
  private foreground = true;
  private rooms: string[] = [];
  private pinned = new Map<string, number>();
  private ws: FeedSocket | null = null;
  private creds: FeedCreds | null = null;
  private joined = '';
  private ref = 0;
  private gen = 0;
  private beat: unknown = null;
  private retry: unknown = null;
  private reauth: unknown = null;
  private backoff: Backoff;

  constructor(private readonly deps: FeedDeps) {
    this.backoff = new Backoff(deps.random);
  }

  /** Rows for `room` (a room id), or every watched room without one. Returns an unsubscribe. */
  on(room: string | undefined, cb: (row: FeedRow) => void): () => void {
    const l: Listener = { room, cb };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Hold the socket open (while foreground); the last release closes it. */
  acquire(): () => void {
    this.users++;
    if (this.users === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.users--;
      if (this.users === 0) this.stop();
    };
  }

  /** The user's rooms, most recent first (the notify poll's room list). */
  setRooms(ids: string[]) {
    this.rooms = ids;
    this.rejoin();
  }

  /** Keep `id` watched (the open chat room) until the returned function is called. */
  pin(id: string): () => void {
    this.pinned.set(id, (this.pinned.get(id) ?? 0) + 1);
    this.rejoin();
    return () => {
      const n = (this.pinned.get(id) ?? 1) - 1;
      if (n > 0) this.pinned.set(id, n);
      else this.pinned.delete(id);
      this.rejoin();
    };
  }

  watched(): string[] {
    return pickRooms(this.rooms, [...this.pinned.keys()]);
  }

  setForeground(on: boolean) {
    if (on === this.foreground) return;
    this.foreground = on;
    if (on) {
      this.backoff.ok();
      this.start();
    } else this.stop();
  }

  get open() {
    return !!this.ws;
  }

  private emit(row: FeedRow) {
    for (const l of [...this.listeners]) {
      if (l.room && l.room !== row.room_id) continue;
      try {
        l.cb(row);
      } catch {
        /* a listener's bug never kills the feed */
      }
    }
  }

  private send(topic: string, event: string, payload: unknown, joinRef?: string) {
    const ref = String(++this.ref);
    try {
      this.ws?.send(JSON.stringify({ topic, event, payload, ref, join_ref: joinRef ?? null }));
    } catch {
      /* closed under us: onclose reconnects */
    }
    return ref;
  }

  /** (Re)join the one channel with the current room set; leaves the old join first. */
  private rejoin() {
    if (!this.ws || !this.creds) return;
    const ids = this.watched();
    const key = ids.join(',');
    if (key === this.joined) return;
    if (this.joined) this.send(TOPIC, 'phx_leave', {});
    this.joined = key;
    if (!ids.length) return;
    this.send(TOPIC, 'phx_join', {
      config: {
        broadcast: { self: false },
        presence: { key: '' },
        postgres_changes: [
          { event: 'INSERT', schema: 'public', table: 'ticker_room_messages', filter: filterFor(ids) },
        ],
      },
      access_token: this.creds.token,
    });
  }

  private clearTimers() {
    if (this.beat) this.deps.clearInterval(this.beat);
    if (this.retry) this.deps.clearTimer(this.retry);
    if (this.reauth) this.deps.clearTimer(this.reauth);
    this.beat = this.retry = this.reauth = null;
  }

  private stop() {
    this.gen++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.joined = '';
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private start() {
    if (!this.foreground || this.users === 0) return;
    this.stop();
    void this.connect(this.gen);
  }

  private failed(gen: number) {
    if (gen !== this.gen) return;
    this.stop();
    const g = this.gen;
    const { delay } = this.backoff.fail(this.deps.now());
    this.retry = this.deps.setTimer(() => {
      this.retry = null;
      if (g === this.gen) this.start();
    }, delay);
  }

  private scheduleReauth(gen: number, expiresAt: number) {
    const ms = Math.max(30_000, expiresAt - this.deps.now() - 60_000);
    this.reauth = this.deps.setTimer(async () => {
      this.reauth = null;
      if (gen !== this.gen) return;
      const fresh = await this.deps.creds();
      if (gen !== this.gen) return;
      if (!fresh) return this.scheduleReauth(gen, this.deps.now() + 60_000);
      this.creds = fresh;
      if (this.joined) this.send(TOPIC, 'access_token', { access_token: fresh.token });
      this.scheduleReauth(gen, fresh.expiresAt);
    }, ms);
  }

  private async connect(gen: number) {
    const c = await this.deps.creds();
    if (gen !== this.gen) return;
    if (!c) return this.failed(gen);
    this.creds = c;
    let ws: FeedSocket;
    try {
      ws = this.deps.socket(socketUrl(c));
    } catch {
      return this.failed(gen);
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.backoff.ok();
      this.rejoin();
      this.beat = this.deps.setInterval(() => this.send('phoenix', 'heartbeat', {}), HEARTBEAT_MS);
      this.scheduleReauth(gen, c.expiresAt);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.gen) return;
      const row = rowFromFrame(ev.data);
      if (row) this.emit(row);
    };
    ws.onclose = ws.onerror = () => this.failed(gen);
  }
}

// ───────────────────────────── App singleton ─────────────────────────────

let feed: RoomFeed | null = null;

/** UI pages only (never the MV3 service worker), and only where WebSocket exists. */
export const roomFeed = (): RoomFeed | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof WebSocket === 'undefined') return null;
  if (feed) return feed;
  const f = new RoomFeed({
    creds: credsFrom(defaultHttp(Capacitor.isNativePlatform()), () => loadSession()),
    socket: (url) => new WebSocket(url) as unknown as FeedSocket,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
    random: Math.random,
  });
  feed = f;
  f.setForeground(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', () => f.setForeground(document.visibilityState !== 'hidden'));
  if (Capacitor.isNativePlatform())
    void App.addListener('appStateChange', ({ isActive }) => f.setForeground(isActive)).catch(() => undefined);
  return f;
};

/** While mounted and enabled: keep `roomId` watched and call `fn` (coalesced, 250 ms) on its inserts. */
export const useRoomFeed = (roomId: string | undefined, fn: () => void, enabled = true) => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const f = roomFeed();
    if (!f || !roomId || !enabled) return;
    const release = f.acquire();
    const unpin = f.pin(roomId);
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = f.on(roomId, () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        ref.current();
      }, 250);
    });
    return () => {
      if (t) clearTimeout(t);
      off();
      unpin();
      release();
    };
  }, [roomId, enabled]);
};
