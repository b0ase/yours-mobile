/**
 * Regular Spaces: the weekly schedule (GET /api/bitsign/spaces/schedule, edited as data on the server).
 * Each slot is a recurring time in a real persistent room (/s/<room>). Times are wall-clock in the
 * schedule's zone (Europe/London) and shown in the viewer's own time. Pure, so it is tested.
 */
/** Public room pages (guest-first /s/<room>) live on bChatX. */
export const PUBLIC_SPACES_ORIGIN = 'https://www.bchatx.com';
export const roomPageUrl = (ticker: string) => `${PUBLIC_SPACES_ORIGIN}/s/${ticker.toLowerCase()}`;

export interface ScheduleSlot {
  id: string;
  title: string;
  blurb: string;
  room: string;
  /** 0 = Sunday. */
  weekday: number;
  /** "HH:MM" in tz. */
  start: string;
  durationMin: number;
  /** Null: an open room, anyone can join at that time. */
  host: string | null;
}
export interface Schedule {
  tz: string;
  slots: ScheduleSlot[];
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export const parseSchedule = (data: unknown): Schedule => {
  const d = rec(data);
  const tz = typeof d.tz === 'string' && d.tz ? d.tz : 'Europe/London';
  const slots = (Array.isArray(d.slots) ? d.slots : []).flatMap((raw): ScheduleSlot[] => {
    const s = rec(raw);
    const ok =
      typeof s.id === 'string' &&
      typeof s.title === 'string' &&
      typeof s.room === 'string' &&
      /^[A-Za-z0-9_-]{1,32}$/.test(s.room) &&
      typeof s.weekday === 'number' &&
      s.weekday >= 0 &&
      s.weekday <= 6 &&
      typeof s.start === 'string' &&
      /^\d{2}:\d{2}$/.test(s.start);
    if (!ok) return [];
    return [
      {
        id: s.id as string,
        title: s.title as string,
        blurb: typeof s.blurb === 'string' ? s.blurb : '',
        room: (s.room as string).toUpperCase(),
        weekday: s.weekday as number,
        start: s.start as string,
        durationMin: typeof s.durationMin === 'number' && s.durationMin > 0 ? s.durationMin : 60,
        host: typeof s.host === 'string' && s.host ? s.host : null,
      },
    ];
  });
  return { tz, slots };
};

/** Minutes the zone is ahead of UTC at this instant. */
const offsetMin = (tz: string, at: number): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (
    (Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - Math.floor(at / 60_000) * 60_000) / 60_000
  );
};

/** The UTC instant of wall time y-m-d h:mi in tz. */
export const zonedToUtc = (tz: string, y: number, m: number, d: number, h: number, mi: number): number => {
  const guess = Date.UTC(y, m, d, h, mi);
  let at = guess - offsetMin(tz, guess) * 60_000;
  at = guess - offsetMin(tz, at) * 60_000;
  return at;
};

/** The wall-clock date in tz for an instant. */
const zonedDate = (tz: string, at: number) => {
  const local = at + offsetMin(tz, at) * 60_000;
  const d = new Date(local);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
};

/** The current session if one is running, else the next one: { start, end } in ms. */
export const nextSession = (slot: ScheduleSlot, tz: string, now: number): { start: number; end: number } => {
  const [h, mi] = slot.start.split(':').map(Number);
  const today = zonedDate(tz, now);
  // From 7 days back (a session that started yesterday may still be on) forward.
  for (let i = -1; i <= 7; i++) {
    const day = (today.wd + i + 7) % 7;
    if (day !== slot.weekday) continue;
    const start = zonedToUtc(tz, today.y, today.m, today.d + i, h, mi);
    const end = start + slot.durationMin * 60_000;
    if (end > now) return { start, end };
  }
  const start = zonedToUtc(tz, today.y, today.m, today.d + 7, h, mi);
  return { start, end: start + slot.durationMin * 60_000 };
};

/** "Live now", "Starts in 12 min", "Starts in 2h", "Starts in 3 days". */
export const whenLabel = (s: { start: number; end: number }, now: number): string => {
  if (now >= s.start && now < s.end) return 'Live now';
  const min = Math.round((s.start - now) / 60_000);
  if (min < 60) return `Starts in ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Starts in ${h}h`;
  const days = Math.round(h / 24);
  return `Starts in ${days} day${days === 1 ? '' : 's'}`;
};

const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const icsUtc = (at: number) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const icsText = (t: string) =>
  t
    .replace(/\\/g, '\\\\')
    .replace(/[,;]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');

/** A weekly recurring calendar event for the slot (TZID so it follows the clock change). */
export const slotIcs = (slot: ScheduleSlot, tz: string, now: number, url: string): string => {
  const { start } = nextSession(slot, tz, now);
  const local = new Date(start + offsetMin(tz, start) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const dt = `${local.getUTCFullYear()}${p(local.getUTCMonth() + 1)}${p(local.getUTCDate())}T${p(local.getUTCHours())}${p(local.getUTCMinutes())}00`;
  const durH = Math.floor(slot.durationMin / 60);
  const durM = slot.durationMin % 60;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bWalletX//Spaces//EN',
    'BEGIN:VEVENT',
    `UID:${slot.id}@spaces.bwalletx.com`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART;TZID=${tz}:${dt}`,
    `DURATION:PT${durH ? `${durH}H` : ''}${durM ? `${durM}M` : ''}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAYS[slot.weekday]}`,
    `SUMMARY:${icsText(slot.title)}`,
    `DESCRIPTION:${icsText(`${slot.blurb}\n${url}`)}`,
    `URL:${url}`,
    `LOCATION:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
};

/**
 * Scheduled Spaces coming up across public rooms: real bookings only (confirmed or live), from
 * bChatX GET /api/public/spaces/upcoming. Never made-up content (owner, 18 Oct 2026).
 */
export interface UpcomingSpace {
  id: string;
  title: string;
  description: string | null;
  room: { ticker: string; name: string };
  host: string;
  /** Epoch ms. */
  start: number;
  end: number;
  live: boolean;
}

export const parseUpcoming = (data: unknown): UpcomingSpace[] => {
  const items = rec(data).items;
  return (Array.isArray(items) ? items : []).flatMap((raw): UpcomingSpace[] => {
    const s = rec(raw);
    // room is the ticker; roomName its label (older shape: room { ticker, name }).
    const room = typeof s.room === 'string' ? { ticker: s.room, name: s.roomName } : rec(s.room);
    const start = typeof s.startsAt === 'string' ? Date.parse(s.startsAt) : NaN;
    const ok =
      typeof s.id === 'string' &&
      typeof s.title === 'string' &&
      !!s.title.trim() &&
      typeof room.ticker === 'string' &&
      /^[A-Za-z0-9_-]{1,32}$/.test(room.ticker) &&
      typeof s.host === 'string' &&
      (s.status === 'confirmed' || s.status === 'live') &&
      Number.isFinite(start);
    if (!ok) return [];
    const mins = typeof s.durationMin === 'number' && s.durationMin > 0 ? s.durationMin : 60;
    const ticker = (room.ticker as string).toUpperCase();
    return [
      {
        id: s.id as string,
        title: (s.title as string).trim(),
        description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : null,
        room: { ticker, name: typeof room.name === 'string' && room.name ? room.name : `$${ticker}` },
        host: (s.host as string).replace(/^\$/, ''),
        start,
        end: start + mins * 60_000,
        live: s.status === 'live',
      },
    ];
  });
};
