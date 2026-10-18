/**
 * bCal: ONE calendar for bWalletX, bChatX and bcalx.com (owner, 18 Oct 2026). Every scheduled Space is
 * a booking in bit-sign; this reads the same feeds everyone reads:
 *   public  GET /api/public/spaces/upcoming   → All
 *   yours   GET /api/bitsign/me/spaces/calendar → Following / Mine (signed in)
 * Each event can carry a signed on-chain record (bit-sign docs/BCAL-SPEC.md) → "On chain ↗".
 * Pure, so it is tested (calendar.test.ts).
 */
export const BCALX_ORIGIN = 'https://bcalx.com';

export interface CalEvent {
  id: string;
  title: string;
  room: string;
  roomName: string;
  host: string;
  guests: string[];
  startsAt: string;
  durationMin: number;
  status: string;
  chainTxid: string | null;
  mine: boolean;
  following: boolean;
}

export type CalFilter = 'all' | 'following' | 'mine';

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const handle = (v: unknown) => str(v, 64).replace(/^[$@]/, '');

/** One upstream item → event, or null when it lacks an id, title, room or a valid start. */
export const parseEvent = (raw: unknown): CalEvent | null => {
  const x = rec(raw);
  const id = str(x.id, 80);
  const title = str(x.title, 120);
  const room = str(x.room ?? x.ticker, 40)
    .replace(/^\$/, '')
    .toUpperCase();
  const t0 = Date.parse(str(x.startsAt ?? x.starts_at, 40));
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !title || !/^[A-Z0-9_-]{1,40}$/.test(room) || !Number.isFinite(t0))
    return null;
  const dur = Number(x.durationMin ?? x.duration_min);
  const txid = str(x.chainTxid ?? x.chain_txid, 64).toLowerCase();
  return {
    id,
    title,
    room,
    roomName: str(x.roomName ?? x.room_name, 80) || room,
    host: handle(x.host ?? x.host_handle),
    guests: (Array.isArray(x.guests) ? x.guests : []).map(handle).filter(Boolean).slice(0, 8),
    startsAt: new Date(t0).toISOString(),
    durationMin: Number.isFinite(dur) && dur > 0 ? Math.min(24 * 60, Math.round(dur)) : 60,
    status: str(x.status, 20) || 'confirmed',
    chainTxid: /^[0-9a-f]{64}$/.test(txid) ? txid : null,
    mine: x.mine === true,
    following: x.following === true || x.mine === true,
  };
};

const items = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  const d = rec(data);
  return Array.isArray(d.items) ? d.items : [];
};

/**
 * Merge the public feed with yours: one row per event id (yours wins, it knows mine/following),
 * upcoming or live only, soonest first.
 */
export const mergeCalendar = (pub: unknown, yours: unknown, now: number): CalEvent[] => {
  const byId = new Map<string, CalEvent>();
  for (const e of items(pub).map(parseEvent)) if (e) byId.set(e.id, e);
  for (const e of items(yours).map(parseEvent)) {
    if (!e) continue;
    const had = byId.get(e.id);
    byId.set(e.id, { ...e, chainTxid: e.chainTxid ?? had?.chainTxid ?? null });
  }
  return [...byId.values()]
    .filter((e) => e.status === 'live' || Date.parse(e.startsAt) + e.durationMin * 60_000 > now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
};

export const filterCalendar = (events: CalEvent[], f: CalFilter): CalEvent[] =>
  f === 'mine' ? events.filter((e) => e.mine) : f === 'following' ? events.filter((e) => e.following) : events;

export const isLiveNow = (e: CalEvent, now: number) => {
  const t0 = Date.parse(e.startsAt);
  return e.status === 'live' || (now >= t0 && now < t0 + e.durationMin * 60_000);
};

export const reminderSlot = (id: string) => `booking:${id}`;
export const eventPageUrl = (id: string) => `${BCALX_ORIGIN}/e/${encodeURIComponent(id)}`;
export const chainUrl = (txid: string) => `https://whatsonchain.com/tx/${txid}`;

const icsTime = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const icsText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** One event as .ics. UID matches bcalx.com's, so adding it from both places is one calendar entry. */
export const eventIcs = (e: CalEvent, spaceUrl: string, now: number): string => {
  const t0 = Date.parse(e.startsAt);
  const desc = [
    `Live Space in ${e.roomName}.`,
    e.host ? `Host: $${e.host}` : '',
    `Join: ${spaceUrl}`,
    `Details: ${eventPageUrl(e.id)}`,
    e.chainTxid ? `On chain: ${chainUrl(e.chainTxid)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bWalletX//bCal//EN',
    'BEGIN:VEVENT',
    `UID:${e.id}@bcalx.com`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(t0)}`,
    `DTEND:${icsTime(t0 + e.durationMin * 60_000)}`,
    `SUMMARY:${icsText(e.title)}`,
    `DESCRIPTION:${icsText(desc)}`,
    `URL:${spaceUrl}`,
    `LOCATION:${spaceUrl}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(e.title)} starts in 15 minutes`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
};
