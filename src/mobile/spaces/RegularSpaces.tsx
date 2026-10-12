/**
 * The top of /m/spaces for everyone, signed in or not (guest-first: listening works signed out):
 *  - Featured: real persistent rooms from bit-sign's public directory (GET /api/bitsign/spaces),
 *    the Lounge pinned first and always open, then any live public Space. Real counts only.
 *  - Regular Spaces: the weekly schedule (GET /api/bitsign/spaces/schedule), each slot in a real
 *    room at /s/<room>, shown in the viewer's local time, with Add to calendar (.ics).
 * bWalletX only: lives in the lazy SpacesPage chunk (storeBuild.ts BSPACES_ENABLED).
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarPlus, Radio } from 'lucide-react';
import { BCHAT_ORIGIN, defaultHttp } from '../chat/api';
import { isNative } from '../native';
import { defaultPictures } from '../chat/roomArt';
import {
  nextSession,
  roomPageUrl,
  parseSchedule,
  slotIcs,
  whenLabel,
  type Schedule,
  type ScheduleSlot,
} from './schedule';

const GOLD = '#FFD24D';
const INK = '#0B0A08';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
interface FeaturedCard {
  ticker: string;
  room_name: string;
  title: string;
  cover: string | null;
  speakers: number;
  listeners: number;
  always_open?: boolean;
  gated: boolean;
}

const getJson = async (path: string): Promise<unknown> => {
  const r = await defaultHttp(isNative)({ method: 'GET', url: `${BCHAT_ORIGIN}${path}`, headers: {} });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.data;
};

const parseFeatured = (data: unknown): FeaturedCard[] => {
  const live = (data as { live?: unknown } | null)?.live;
  const cards = (Array.isArray(live) ? live : []).filter(
    (c): c is FeaturedCard => !!c && typeof (c as FeaturedCard).ticker === 'string',
  );
  // Lounge pinned first, then always-open rooms, then by people in the room. One card per room.
  const seen = new Set<string>();
  return cards
    .sort(
      (a, b) =>
        Number(b.ticker === 'LOUNGE') - Number(a.ticker === 'LOUNGE') ||
        Number(!!b.always_open) - Number(!!a.always_open) ||
        b.speakers + b.listeners - (a.speakers + a.listeners),
    )
    .filter((c) => {
      if (seen.has(c.ticker)) return false;
      seen.add(c.ticker);
      return true;
    });
};

const coverUrl = (c: FeaturedCard): string | null => {
  if (!c.cover) return null;
  if (/^https:\/\//.test(c.cover)) return c.cover;
  return c.cover.startsWith('/') ? `${BCHAT_ORIGIN}${c.cover}` : null;
};

/** Gold art: the room cover, else the gold bAvatar for the room (never grey). */
const GoldArt = ({ cover, seed }: { cover: string | null; seed: string }) => {
  const candidates = useMemo(() => [...(cover ? [cover] : []), ...defaultPictures(seed)], [cover, seed]);
  const [i, setI] = useState(0);
  return (
    <img
      src={candidates[Math.min(i, candidates.length - 1)]}
      alt=""
      onError={() => setI((n) => n + 1)}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
};

const downloadIcs = (slot: ScheduleSlot, tz: string) => {
  const blob = new Blob([slotIcs(slot, tz, Date.now(), roomPageUrl(slot.room))], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slot.id}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const RegularSpaces = ({ onJoin }: { onJoin: (ticker: string, name: string) => void }) => {
  const [featured, setFeatured] = useState<FeaturedCard[] | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleError, setScheduleError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = () => {
      getJson('/api/bitsign/spaces')
        .then((d) => alive && setFeatured(parseFeatured(d)))
        .catch(() => alive && setFeatured((f) => f ?? []));
    };
    load();
    getJson('/api/bitsign/spaces/schedule')
      .then((d) => alive && setSchedule(parseSchedule(d)))
      .catch(() => alive && setScheduleError(true));
    const poll = setInterval(load, 30_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const roomNames = useMemo(() => new Map((featured ?? []).map((c) => [c.ticker, c.room_name])), [featured]);
  const slots = useMemo(() => {
    if (!schedule) return [];
    return schedule.slots
      .map((slot) => ({ slot, when: nextSession(slot, schedule.tz, now) }))
      .sort((a, b) => a.when.start - b.when.start);
  }, [schedule, now]);

  return (
    <div>
      <Label>Featured</Label>
      {featured === null ? (
        <div className="px-4 py-6">
          <Radio size={22} color={GOLD} className="animate-pulse" />
        </div>
      ) : featured.length === 0 ? (
        <p className="px-4 text-sm" style={{ color: MUTED }}>
          No public rooms are open right now.
        </p>
      ) : (
        <div className="flex gap-3 overflow-x-auto px-4 pb-2 snap-x">
          {featured.map((c) => {
            const here = c.speakers + c.listeners;
            return (
              <div
                key={c.ticker}
                className="relative shrink-0 snap-start overflow-hidden rounded-2xl"
                style={{ width: 260, height: 170, background: GOLD, boxShadow: '0 6px 24px rgba(245,197,66,0.18)' }}
              >
                <GoldArt cover={coverUrl(c)} seed={c.ticker} />
                <div
                  className="absolute inset-0"
                  style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.85) 100%)' }}
                />
                <div className="absolute left-3 top-3 flex gap-1.5">
                  {here > 0 ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: '#D92D20', color: '#fff' }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden="true" />
                      Live · {here} {here === 1 ? 'person' : 'people'}
                    </span>
                  ) : c.always_open ? (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: GOLD, color: INK }}
                    >
                      Open 24/7
                    </span>
                  ) : null}
                  {c.gated && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: INK, color: GOLD }}
                    >
                      Holders
                    </span>
                  )}
                </div>
                <div className="absolute inset-x-3 bottom-3 flex items-end gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[16px] font-extrabold text-white">
                      {c.title || c.room_name}
                    </span>
                    <span
                      className="block overflow-hidden text-ellipsis whitespace-nowrap text-[12px]"
                      style={{ color: '#e8d9a8' }}
                    >
                      /s/{c.ticker.toLowerCase()}
                    </span>
                  </span>
                  <button
                    onClick={() => onJoin(c.ticker, c.room_name)}
                    className="shrink-0 rounded-full px-4 py-1.5 text-[13px] font-bold"
                    style={{ background: GOLD, color: INK }}
                  >
                    Join
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Label>Regular Spaces</Label>
      {scheduleError && !schedule ? (
        <p className="px-4 text-sm" style={{ color: MUTED }}>
          The schedule didn’t load. Tap refresh to try again.
        </p>
      ) : !schedule ? null : (
        <div>
          <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
            Every week, in your local time. A slot with no host is an open room: anyone can join.
          </p>
          {slots.map(({ slot, when }) => {
            const label = whenLabel(when, now);
            const isLive = label === 'Live now';
            const roomName = roomNames.get(slot.room) ?? `$${slot.room}`;
            return (
              <div
                key={slot.id}
                className="flex items-center gap-3 px-4 py-3"
                style={{ borderTop: `1px solid ${LINE}` }}
              >
                <div className="w-[64px] shrink-0 text-center">
                  <div className="text-[12px] font-semibold" style={{ color: GOLD }}>
                    {dayFmt.format(when.start)}
                  </div>
                  <div className="text-[13px] font-bold">{timeFmt.format(when.start)}</div>
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{slot.title}</span>
                  <span className="block text-xs" style={{ color: MUTED }}>
                    {slot.blurb}
                  </span>
                  <span className="block text-xs" style={{ color: MUTED }}>
                    {roomName} · {slot.host ? `Host $${slot.host}` : 'Open room'} ·{' '}
                    <span style={{ color: isLive ? '#F97066' : GOLD }}>{label}</span>
                  </span>
                </span>
                <button
                  onClick={() => downloadIcs(slot, schedule.tz)}
                  aria-label={`Add ${slot.title} to calendar`}
                  title="Add to calendar"
                  className="shrink-0 rounded-full p-2"
                  style={{ border: `1px solid ${LINE}` }}
                >
                  <CalendarPlus size={16} color={MUTED} />
                </button>
                <button
                  onClick={() => onJoin(slot.room, roomName)}
                  className="shrink-0 rounded-full px-3 py-1 text-xs font-bold"
                  style={isLive ? { background: GOLD, color: INK } : { border: `1px solid ${GOLD}`, color: GOLD }}
                >
                  {isLive ? 'Join' : 'Open room'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Label = ({ children }: { children: React.ReactNode }) => (
  <h2 className="px-4 pt-5 pb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
    {children}
  </h2>
);
