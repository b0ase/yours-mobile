/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Native-vs-WebView room bench (dev only, vite.config.ncbench.ts; run by a DEBUG launch argument). Same fixture and the
 * same "no network" for both. Native timing is taken in Swift (NCBench.swift); this drives the bridge for it, and times
 * the real WebView room component here.
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Component, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ServiceContext } from '../../../contexts/ServiceContext';
import { BottomMenuContext } from '../../../contexts/BottomMenuContext';
import { SnackbarContext } from '../../../contexts/SnackbarContext';
import { ThemeContext } from '../../../contexts/ColorThemeContext';
import { ChatConversation } from '../../tabs/ChatPage';
import { writeThread, peekThread, readThread } from '../../chat/threadCache';
import { emptyPrefs } from '../../chat/listPrefs';
import type { ChatMessage } from '../../chat/messages';
import { NativeRoomSession } from '../roomSession';
import { NativeChat } from '../plugin';
import { diffRows, roomRows, threadRows } from '../rows';
import { BENCH_ME, fixtureMessages, fixtureRoom } from './fixture';
import '../../mobile.css';

const noop = () => {};

const save = (path: string, data: unknown) =>
  Filesystem.writeFile({
    path,
    data: JSON.stringify(data, null, 1),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });

const rooms = [
  fixtureRoom('CACHED50', 'Cached 50'),
  fixtureRoom('COLD50', 'Cold 50'),
  fixtureRoom('COLD5000', 'Cold 5000'),
  fixtureRoom('PAGING200', 'Paging 200'),
];
const fixtures: Record<string, ReturnType<typeof fixtureMessages>> = {
  CACHED50: fixtureMessages(50, 'c'),
  COLD50: fixtureMessages(50, 'd'),
  COLD5000: fixtureMessages(5000, 'e'),
  PAGING200: fixtureMessages(200, 'p'),
};
const NOW = new Date('2026-11-08T12:30:00.000Z');

const pushRows = (ticker: string, cacheable = true) => {
  const rows = threadRows(fixtures[ticker], BENCH_ME, { now: NOW });
  const patch = diffRows([], rows)!;
  return NativeChat.setRoom({
    ticker,
    from: patch.from,
    rowsJson: JSON.stringify(patch.rows),
    hasMore: false,
    cacheable,
    loading: false,
    error: '',
    composerJson: JSON.stringify({ kind: 'open' }),
  });
};

const runNative = async (mode: string) => {
  const statusBar = 59; // simulator safe-area top on this device; a real run reads the probe element.
  await NativeChat.show({
    top: statusBar + 56,
    left: 0,
    width: innerWidth,
    height: innerHeight - statusBar - 56 - 83,
    me: BENCH_ME,
  });
  await NativeChat.setRooms({ roomsJson: JSON.stringify(roomRows(rooms, BENCH_ME, emptyPrefs(), { now: NOW })) });
  let session: NativeRoomSession | null = null;
  let pagingShown = 0;
  void NativeChat.addListener('action', (a: any) => {
    if (mode === 'paging') {
      // Newest 50 first, then a page of 50 older each time native asks; every update crosses the bridge whole.
      if (a.type === 'open' || a.type === 'older') {
        pagingShown = a.type === 'open' ? 50 : Math.min(200, pagingShown + 50);
        const shown = fixtures[a.ticker].slice(-pagingShown);
        const rows = threadRows(shown, BENCH_ME, { now: NOW });
        void NativeChat.setRoom({
          ticker: a.ticker,
          from: 0,
          rowsJson: JSON.stringify(rows),
          hasMore: pagingShown < 200,
          cacheable: false,
          loading: false,
          error: '',
          composerJson: JSON.stringify({ kind: 'open' }),
        });
      }
      return;
    }
    if (mode !== 'shots') {
      if (a.type === 'open') void pushRows(a.ticker, a.ticker !== 'COLD50');
      return;
    }
    // Screenshots run the real session over the bridge, against the fixture.
    if (a.type === 'open') {
      let sent: ChatMessage[] = [];
      session = new NativeRoomSession({
        client: {
          latestPage: async () => ({ messages: fixtures[a.ticker], hasMore: false }),
          since: async () => sent,
          page: async () => ({ messages: [], hasMore: false }),
          markRead: async () => undefined,
          send: async (_t: string, body: string) => {
            await new Promise((r) => setTimeout(r, 1500));
            const m = {
              id: `srv-${Date.now()}`,
              author_handle: BENCH_ME,
              kind: 'text',
              body,
              created_at: new Date().toISOString(),
            };
            sent = [m];
            return m;
          },
        } as any,
        me: BENCH_ME,
        room: rooms.find((r) => r.ticker === a.ticker)!,
        viewerIsAdmin: false,
        cache: { peek: () => null, read: async () => null, write: () => undefined },
        blocked: () => [],
        emit: (u) => {
          const patch = diffRows([], u.rows) ?? { from: 0, rows: [] };
          void NativeChat.setRoom({
            ticker: a.ticker,
            from: patch.from,
            rowsJson: JSON.stringify(patch.rows),
            hasMore: u.hasMore,
            cacheable: u.cacheable,
            loading: u.loading,
            error: u.error,
            composerJson: JSON.stringify(u.composer),
          });
        },
        onAuthLost: noop,
        onLocked: noop,
        onClassic: noop,
      });
      void session.open();
    } else if (a.type === 'send') void session?.send(a.text);
  });
  await pushRows('CACHED50');
  (NativeChat as any).benchStart({ mode });
};

// ── WebView room ──────────────────────────────────────────────────────────────────────────────

// A stubbed wallet: every call returns something promise-shaped that never settles, so background lookups just stay idle.
const deepStub = (called = false): any => {
  const self: any = new Proxy(function () {}, {
    get: (_t, k) =>
      k === Symbol.toPrimitive
        ? () => ''
        : typeof k === 'symbol'
          ? undefined
          : k === 'then'
            ? called
              ? () => self
              : undefined
            : deepStub(called),
    apply: () => deepStub(true),
  });
  return self;
};

const clientFor = (ticker: string, latest: boolean) =>
  new Proxy(
    {
      latestPage: async () => ({ messages: latest ? fixtures[ticker] : [], hasMore: false }),
      since: async () => [],
      page: async () => ({ messages: [], hasMore: false }),
      markRead: async () => undefined,
      whoIsTyping: async () => [],
      typing: async () => undefined,
      current: { address: 'x', token: 'x', handle: BENCH_ME },
    } as any,
    {
      get(t, k) {
        if (k in t) return t[k as string];
        if (typeof k === 'symbol' || k === 'then') return undefined;
        // Anything else the room asks for: nothing there.
        return async () => null;
      },
    },
  );

const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const bubbles = () => document.querySelectorAll('.bw-chat-bubble').length;

type Open = { ticker: string; client: any; id: number } | null;
let setOpen: (o: Open) => void = () => {};

// eslint-disable-next-line react-refresh/only-export-components
const Harness = () => {
  const [o, set] = useState<Open>(null);
  setOpen = set;
  if (!o) return null;
  return (
    <ChatConversation
      key={o.id}
      client={o.client}
      room={fixtureRoom(o.ticker, o.ticker)}
      me={BENCH_ME}
      online
      onBack={noop}
      onAuthLost={noop}
      entry={null}
      onLocked={noop}
      onInvite={null}
      onBans={null}
      onBounties={null}
      bell={false}
    />
  );
};

const openWeb = async (ticker: string, latest: boolean, expect: number, id: number) => {
  setOpen(null);
  await raf();
  await raf();
  const t0 = performance.now();
  setOpen({ ticker, client: clientFor(ticker, latest), id });
  await raf();
  await raf();
  const firstPaint = performance.now() - t0;
  while (bubbles() < expect) {
    if (performance.now() - t0 > (expect > 1000 ? 240_000 : 20_000)) throw new Error(`timeout: ${bubbles()}/${expect}`);
    await raf();
  }
  await raf();
  return { firstPaintMs: Math.round(firstPaint * 10) / 10, contentMs: Math.round((performance.now() - t0) * 10) / 10 };
};

const scrollWeb = async () => {
  const el = document.querySelector('.bw-room-list') as HTMLElement;
  const speed = 3000; // pt/s, same as native
  const dur = 8000;
  const start = performance.now();
  el.scrollTop = el.scrollHeight;
  await raf();
  const stamps: number[] = [];
  let top = el.scrollTop;
  let last = performance.now();
  while (performance.now() - start < dur) {
    const now = await raf();
    stamps.push(now);
    top = Math.max(0, top - (speed * (now - last)) / 1000);
    el.scrollTop = top;
    last = now;
  }
  const d = stamps.slice(1).map((s, i) => s - stamps[i]);
  const sorted = [...d].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const ft = 1000 / 60;
  const hitches = d.filter((x) => x > ft * 1.5);
  return {
    frames: d.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    maxMs: sorted[sorted.length - 1],
    hitches: hitches.length,
    hitchMsPerSec: hitches.reduce((n, x) => n + x - ft, 0) / (dur / 1000),
  };
};

const runWeb = async () => {
  const out: Record<string, unknown> = { ua: navigator.userAgent };
  try {
    // The thread cache survives relaunches: without this a "cold" room is cached from the previous run.
    await new Promise<void>((res) => {
      const r = indexedDB.deleteDatabase('bwallet-thread-cache');
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
    localStorage.removeItem('bwallet:thread-cache');
    const expect = (t: string) => fixtures[t].filter((m) => m.kind === 'text').length;
    // Empty open first: nothing measured until the page and its CSS are settled.
    await openWeb('CACHED50', true, 1, 0);
    writeThread(BENCH_ME, 'CACHED50', fixtures.CACHED50);
    while (!peekThread(BENCH_ME, 'CACHED50')) await readThread(BENCH_ME, 'CACHED50');
    out.cachedRoom50 = await openWeb('CACHED50', false, expect('CACHED50'), 1);
    out.coldRoom50 = await openWeb('COLD50', true, expect('COLD50'), 2);
    out.coldRoom5000 = await openWeb('COLD5000', true, expect('COLD5000'), 3);
    await raf();
    await new Promise((r) => setTimeout(r, 2000));
    out.scroll5000 = await scrollWeb();
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.errors = [...new Set(errors.map((e) => e.slice(0, 300)))].slice(0, 5);
  out.bubblesAtEnd = bubbles();
  await save('nc-bench-web.json', out);
};

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${String(e.reason)}`));
const origError = console.error;
console.error = (...a: unknown[]) => {
  errors.push(`console: ${a.map(String).join(' ').slice(0, 400)}`);
  origError(...a);
};

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error, info: { componentStack?: string | null }) {
    errors.push(`render: ${e.message} ${(info.componentStack ?? '').slice(0, 600)}`);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'native';
const providerValue = {
  apiContext: deepStub(),
  chromeStorageService: { getCurrentAccountObject: () => ({ account: { addresses: {}, settings: {} } }) },
} as any;
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <ServiceContext.Provider value={providerValue}>
      <BottomMenuContext.Provider value={{ selected: undefined, handleSelect: noop, query: '' } as any}>
        <SnackbarContext.Provider value={{ addSnackbar: noop, message: null, severity: undefined } as any}>
          <ThemeContext.Provider value={{ theme: deepStub(), setTheme: noop } as any}>
            <Boundary>
              <Harness />
            </Boundary>
          </ThemeContext.Provider>
        </SnackbarContext.Provider>
      </BottomMenuContext.Provider>
    </ServiceContext.Provider>
  </MemoryRouter>,
);
if (mode === 'web') void runWeb();
else void runNative(mode);
