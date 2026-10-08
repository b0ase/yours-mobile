import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Phone, Video } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { Avatar } from '../chat/ContactViews';
import { useAccountNames } from '../names/accountNames';
import { bareName } from '../names/names';
import { Sheet } from '../phone/Sheet';
import { fetchDirectory, requestBooking, type PeerBPhone } from './bphone';
import { busy, type Peer } from './machine';
import {
  BOOKING_MINUTES,
  bookingSlots,
  CATEGORIES,
  categoryLabel,
  DAYS,
  hoursLabel,
  isOpenAt,
  nextOpening,
  rateShort,
  type Category,
} from './rateCard';
import { dial } from './store';
import { useCalls } from './useCalls';

const GOLD = '#F5B800';
const CLIP = 'overflow-hidden text-ellipsis whitespace-nowrap';
const f = (u: string, i?: RequestInit) => fetch(u, i);

const peerOf = (p: PeerBPhone): Peer => ({
  key: p.key,
  label: p.paymail ?? p.name ?? p.key.slice(0, 10),
  verified: !!p.paymail,
});

/**
 * Chat › Calls › Experts: everyone who has listed themselves in bPhone, with their rate, whether
 * they are open now, and Call / Book. The call itself goes through the normal dial, which shows
 * the rate and asks for a max spend before ringing.
 */
export const Directory = ({ onLeave }: { onLeave?: () => void }) => {
  const { call } = useCalls();
  const [category, setCategory] = useState<Category | ''>('');
  const [list, setList] = useState<PeerBPhone[] | null>(null);
  const [error, setError] = useState('');
  const [booking, setBooking] = useState<PeerBPhone | null>(null);
  const inCall = busy(call);
  const now = Date.now();

  useEffect(() => {
    let live = true;
    setList(null);
    setError('');
    fetchDirectory(f, category || null)
      .then((l) => live && setList(l))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [category]);

  return (
    <div className="flex flex-col gap-3">
      <select
        className="rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
        value={category}
        onChange={(e) => setCategory(e.target.value as Category | '')}
        aria-label="Category"
      >
        <option value="">All categories</option>
        {CATEGORIES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {list === null && !error && (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin" color="#98A2B3" />
        </div>
      )}
      {error && <p className="text-xs text-[#ff6b6b]">{error}</p>}
      {list && list.length === 0 && (
        <p className="text-sm text-[#98A2B3] text-center py-8">Nobody listed here yet. List yourself under bPhone.</p>
      )}
      {list?.map((p) => {
        const { listing, rate } = p.profile;
        const open = isOpenAt(listing.hours, listing.timezone, now);
        const next = open ? null : nextOpening(listing.hours, listing.timezone, now);
        const name = bareName(p.paymail ?? p.name ?? '') || p.key.slice(0, 10);
        return (
          <div key={p.key} className="rounded-2xl border border-[#2b2f36] p-3 flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <Avatar title={name} src={p.avatar} size={44} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold text-white ${CLIP}`}>{listing.title || name}</div>
                <div className={`text-[11px] text-[#98A2B3] ${CLIP}`}>
                  {name} · {categoryLabel(listing.category)}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-bold" style={{ color: GOLD }}>
                  {rate ? rateShort(rate) : 'Free'}
                </div>
                <div className="text-[11px]" style={{ color: open ? '#2ecc71' : '#98A2B3' }}>
                  {open ? 'Open now' : next ? `Opens ${DAYS[next.day]} ${next.from}` : 'Closed'}
                </div>
              </div>
            </div>
            {listing.about && <p className="text-xs text-[#c9ccd1] leading-snug">{listing.about}</p>}
            <div className="text-[11px] text-[#98A2B3]">{hoursLabel(listing.hours)}</div>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-xl py-2 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
                style={{ background: GOLD, color: '#1a1300' }}
                disabled={inCall}
                onClick={() => {
                  void dial(peerOf(p));
                  onLeave?.();
                }}
              >
                <Phone size={15} /> Call
              </button>
              <button
                aria-label="Video call"
                className="w-11 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
                disabled={inCall}
                onClick={() => {
                  void dial(peerOf(p), { video: true });
                  onLeave?.();
                }}
              >
                <Video size={16} color={GOLD} />
              </button>
              {listing.booking && (
                <button
                  className="flex-1 rounded-xl py-2 text-sm font-semibold flex items-center justify-center gap-1.5 border border-[#2b2f36] text-white"
                  onClick={() => setBooking(p)}
                >
                  <CalendarClock size={15} color={GOLD} /> Book
                </button>
              )}
            </div>
          </div>
        );
      })}
      {booking && <BookingSheet peer={booking} onClose={() => setBooking(null)} />}
    </div>
  );
};

/** Ask for a call at a time inside their hours. They confirm; both sides see it under bPhone › Bookings. */
const BookingSheet = ({ peer, onClose }: { peer: PeerBPhone; onClose: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const { paymail, handle } = useAccountNames(identityAddress, '', '', false);
  const [minutes, setMinutes] = useState<number>(30);
  const [at, setAt] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState('');
  const [problem, setProblem] = useState('');
  const slots = useMemo(
    () => bookingSlots(peer.profile.listing, Date.now(), { days: 7, stepMin: 30, durationMin: minutes }).slice(0, 60),
    [peer, minutes],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const t of slots) {
      const k = new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [slots]);
  const rate = peer.profile.rate;
  const name = bareName(peer.paymail ?? peer.name ?? '') || peer.key.slice(0, 10);

  const send = async () => {
    if (!apiContext?.wallet || at === null) return;
    setSending(true);
    setProblem('');
    try {
      await requestBooking(f, apiContext.wallet, {
        calleeKey: peer.key,
        at: new Date(at),
        minutes,
        note,
        callerLabel: paymail || handle,
      });
      setDone('Requested. You will see it under bPhone › Bookings once they confirm.');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet label={`Book ${name}`} onClose={onClose}>
      <div className="text-base font-semibold text-white">Book a call with {name}</div>
      <div className="text-xs text-[#98A2B3]">
        {rate ? `${rateShort(rate)}, paid as you talk when the call happens.` : 'Free call.'} Times shown in your time
        zone.
      </div>
      <div className="flex gap-2">
        {BOOKING_MINUTES.map((m) => (
          <button
            key={m}
            onClick={() => {
              setMinutes(m);
              setAt(null);
            }}
            aria-pressed={minutes === m}
            className="flex-1 rounded-lg py-1.5 text-xs font-bold"
            style={
              minutes === m ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
            }
          >
            {m} min
          </button>
        ))}
      </div>
      <div className="max-h-56 overflow-y-auto flex flex-col gap-2">
        {byDay.length === 0 && <p className="text-xs text-[#98A2B3]">No free slots in the next 7 days.</p>}
        {byDay.map(([day, times]) => (
          <div key={day}>
            <div className="text-[11px] text-[#98A2B3] mb-1">{day}</div>
            <div className="flex flex-wrap gap-1.5">
              {times.map((t) => (
                <button
                  key={t}
                  onClick={() => setAt(t)}
                  aria-pressed={at === t}
                  className="rounded-lg px-2.5 py-1 text-xs"
                  style={
                    at === t ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#fff' }
                  }
                >
                  {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 280))}
        placeholder="What it is about (optional)"
        className="rounded-xl bg-[#101114] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
      />
      {problem && <p className="text-xs text-[#ff6b6b]">{problem}</p>}
      {done ? (
        <>
          <p className="text-xs text-[#2ecc71]">{done}</p>
          <button className="rounded-xl py-3 font-semibold border border-[#2b2f36] text-white" onClick={onClose}>
            Close
          </button>
        </>
      ) : (
        <button
          className="rounded-xl py-3 font-semibold disabled:opacity-50"
          style={{ background: GOLD, color: '#1a1300' }}
          disabled={at === null || sending}
          onClick={() => void send()}
        >
          {sending ? 'Requesting…' : 'Request this time'}
        </button>
      )}
    </Sheet>
  );
};

export default Directory;
