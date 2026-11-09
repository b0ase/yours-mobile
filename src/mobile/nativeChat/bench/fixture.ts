/**
 * Bench fixture: deterministic rows so the native and WebView rooms are measured on the same content. Dev only: built
 * solely through vite.config.ncbench.ts; nothing user-facing imports this.
 */
import type { ChatMessage, ChatRoom } from '../../chat/messages';

const LINES = [
  'Morning all',
  'Anyone looked at the new build yet? The list feels much quicker on my phone than it did last week.',
  'yes',
  'Long one: the thing about a room with a lot of history is that every new message has to be measured and placed, and if that happens on the main thread you can feel it when you scroll back through a busy afternoon.',
  'ok',
  'Sending the notes over now',
  'What time is the call?',
  'Half past',
  'Good news, that fixed it for me too.',
  'Short\nand on\nthree lines',
];
const WHO = ['alice', 'bob', 'carol', 'dave', 'erin', 'me_bench'];

export const BENCH_ME = 'me_bench';

export const fixtureMessages = (count: number, seed = 'r'): ChatMessage[] => {
  const out: ChatMessage[] = [];
  const end = Date.parse('2026-11-08T12:00:00.000Z');
  const step = 11 * 60_000;
  for (let i = 0; i < count; i++) {
    const n = i * 7 + (i % 11);
    out.push({
      id: `${seed}-${i}`,
      author_handle: WHO[n % WHO.length],
      kind: i % 41 === 40 ? 'event' : 'text',
      body: i % 41 === 40 ? `$${WHO[n % WHO.length]} joined the room` : LINES[n % LINES.length],
      created_at: new Date(end - (count - i) * step).toISOString(),
      ...(i % 41 === 40 ? { event_type: 'join', author_handle: null } : {}),
    });
  }
  return out;
};

export const fixtureRoom = (ticker: string, name: string, members = 40): ChatRoom => ({
  id: ticker,
  ticker,
  name,
  party_count: members,
  unread: 0,
  updated_at: '2026-11-08T12:00:00.000Z',
  metadata: { kind: 'open', open: {} },
});
