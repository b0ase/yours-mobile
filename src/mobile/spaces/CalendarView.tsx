/**
 * bCal — the one calendar (owner, 18 Oct 2026: "everyone is on the same calendar system"). The same
 * list bChatX and bcalx.com show: every scheduled Space from bit-sign's bookings, All / Following /
 * Mine, each with Remind me, Add to calendar (.ics), Open the Space and, when the host put it on chain,
 * "On chain ↗". Phone: the home bCal tile (/m/calendar); bSpaces keeps its own Coming up. Desktop: Talk › Calendar.
 * bWalletX only: lives behind BSPACES_ENABLED (storeBuild.ts), like the rest of bSpaces.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, BellRing, CalendarDays, CalendarPlus, Link2 } from 'lucide-react';
import { BCHAT_ORIGIN, BchatClient, defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import {
  chainUrl,
  eventIcs,
  eventPageUrl,
  filterCalendar,
  isLiveNow,
  mergeCalendar,
  reminderSlot,
  type CalEvent,
  type CalFilter,
} from './calendar';
import { roomPageUrl } from './schedule';

const GOLD = 'var(--bw-accent-hi)';
const INK = '#0B0A08';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const getPublic = async (): Promise<unknown> => {
  const r = await defaultHttp(isNative)({
    method: 'GET',
    url: `${BCHAT_ORIGIN}/api/public/spaces/upcoming`,
    headers: {},
  });
  return r.status === 200 ? r.data : null;
};

const downloadIcs = (e: CalEvent) => {
  const blob = new Blob([eventIcs(e, roomPageUrl(e.room), Date.now())], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${e.room.toLowerCase()}-${e.id.slice(0, 8)}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const CalendarView = ({
  onJoin,
  title = 'Calendar',
}: {
  onJoin: (ticker: string, name: string) => void;
  title?: string;
}) => {
  const client = useMemo(() => new BchatClient(defaultHttp(isNative), loadSession()), []);
  const signedIn = !!client.handle;
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [filter, setFilter] = useState<CalFilter>('all');
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [pub, yours, rem] = await Promise.all([
      getPublic().catch(() => null),
      signedIn ? client.myCalendar().catch(() => null) : Promise.resolve(null),
      signedIn ? client.spaceReminders().catch(() => null) : Promise.resolve(null),
    ]);
    setEvents(mergeCalendar(pub, yours, Date.now()));
    const slots = (rem as { slots?: unknown } | null)?.slots;
    if (Array.isArray(slots)) setReminded(new Set(slots.filter((s): s is string => typeof s === 'string')));
  }, [client, signedIn]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 60_000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const remind = async (e: CalEvent) => {
    const slot = reminderSlot(e.id);
    const on = !reminded.has(slot);
    try {
      await client.setSpaceReminder(slot, on);
      setReminded((s) => {
        const n = new Set(s);
        if (on) n.add(slot);
        else n.delete(slot);
        return n;
      });
    } catch {
      /* the button stays as it was */
    }
  };

  const shown = filterCalendar(events ?? [], filter);
  const chips: { id: CalFilter; label: string }[] = signedIn
    ? [
        { id: 'all', label: 'All' },
        { id: 'following', label: 'Following' },
        { id: 'mine', label: 'Mine' },
      ]
    : [{ id: 'all', label: 'All' }];

  return (
    <div data-bcal="">
      <div className="flex items-center gap-2 px-4 pt-5 pb-2">
        <CalendarDays size={14} color={MUTED} />
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
          {title}
        </h2>
        {chips.length > 1 &&
          chips.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilter(c.id)}
              className="rounded-full px-3 py-1 text-[12px] font-semibold"
              style={filter === c.id ? { background: GOLD, color: INK } : { border: `1px solid ${LINE}`, color: MUTED }}
            >
              {c.label}
            </button>
          ))}
      </div>
      {events === null ? null : shown.length === 0 ? (
        <p className="px-4 pb-3 text-sm" style={{ color: MUTED }}>
          {filter === 'mine'
            ? 'You have no Spaces scheduled. Book one from any room.'
            : filter === 'following'
              ? 'Nothing scheduled in your rooms yet.'
              : 'No Spaces are scheduled yet.'}
        </p>
      ) : (
        shown.map((e) => {
          const t0 = Date.parse(e.startsAt);
          const live = isLiveNow(e, now);
          const on = reminded.has(reminderSlot(e.id));
          return (
            <div
              key={e.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              style={{ borderTop: `1px solid ${LINE}` }}
            >
              <div className="w-[72px] shrink-0 text-center">
                <div className="text-[12px] font-semibold" style={{ color: live ? '#F97066' : GOLD }}>
                  {live ? 'Live now' : dayFmt.format(t0)}
                </div>
                <div className="text-[13px] font-bold">{timeFmt.format(t0)}</div>
              </div>
              <span className="min-w-0 flex-1">
                <a
                  href={eventPageUrl(e.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="block font-semibold line-clamp-2"
                >
                  {e.title}
                </a>
                <span className="block text-xs" style={{ color: MUTED }}>
                  {e.roomName} · {e.durationMin} min{e.host ? ` · Host $${e.host}` : ''}
                  {e.mine ? ' · Yours' : ''}
                </span>
                {e.chainTxid && (
                  <a
                    href={chainUrl(e.chainTxid)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold"
                    style={{ color: GOLD }}
                  >
                    <Link2 size={11} /> On chain ↗
                  </a>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {signedIn && !live && (
                  <button
                    onClick={() => void remind(e)}
                    aria-label={on ? `Stop reminding me about ${e.title}` : `Remind me about ${e.title}`}
                    title={on ? 'Reminder set' : 'Remind me'}
                    className="rounded-full p-2"
                    style={on ? { border: `1px solid ${GOLD}` } : { border: `1px solid ${LINE}` }}
                  >
                    {on ? <BellRing size={16} color={GOLD} /> : <Bell size={16} color={MUTED} />}
                  </button>
                )}
                <button
                  onClick={() => downloadIcs(e)}
                  aria-label={`Add ${e.title} to calendar`}
                  title="Add to calendar"
                  className="rounded-full p-2"
                  style={{ border: `1px solid ${LINE}` }}
                >
                  <CalendarPlus size={16} color={MUTED} />
                </button>
                <button
                  onClick={() => onJoin(e.room, e.roomName)}
                  className="rounded-full px-3 py-1 text-xs font-bold"
                  style={live ? { background: GOLD, color: INK } : { border: `1px solid ${GOLD}`, color: GOLD }}
                >
                  {live ? 'Join' : 'Open the Space'}
                </button>
              </span>
            </div>
          );
        })
      )}
    </div>
  );
};
