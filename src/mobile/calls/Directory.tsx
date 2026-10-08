import { useMemo, useState, type ReactNode } from 'react';
import { BadgeCheck, CalendarClock, Loader2, Phone, Video } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { Avatar } from '../chat/ContactViews';
import { useAccountNames } from '../names/accountNames';
import { bareName } from '../names/names';
import { Sheet } from '../phone/Sheet';
import { requestBooking, type PeerBPhone } from './bphone';
import { SERVICE_CHIPS, servicesIn, type ServiceChip } from './phone';
import { busy, type Peer } from './machine';
import { BOOKING_MINUTES, bookingSlots, categoryLabel, DAYS, isOpenAt, nextOpening, rateShort } from './rateCard';
import { dial } from './store';
import { useCalls } from './useCalls';

const GOLD = '#F5B800';
const GREEN = '#2ecc71';
const CLIP = 'overflow-hidden text-ellipsis whitespace-nowrap';
const f = (u: string, i?: RequestInit) => fetch(u, i);

const peerOf = (p: PeerBPhone): Peer => ({
  key: p.key,
  label: p.paymail ?? p.name ?? p.key.slice(0, 10),
  verified: !!p.paymail,
});

const serviceName = (p: PeerBPhone) => bareName(p.name ?? p.paymail ?? '') || p.key.slice(0, 10);

/** "Open now" / "Opens Tue 09:00" / "Closed" for a listing at `now`. */
const openLabel = (p: PeerBPhone, now: number): { text: string; open: boolean } => {
  const { hours, timezone } = p.profile.listing;
  if (isOpenAt(hours, timezone, now)) return { text: 'Open now', open: true };
  const next = nextOpening(hours, timezone, now);
  return { text: next ? `Opens ${DAYS[next.day]} ${next.from}` : 'Closed', open: false };
};

const Badge = ({ children, tone }: { children: ReactNode; tone: 'gold' | 'grey' }) => (
  <span
    className="inline-flex items-center gap-[3px] rounded-full px-[6px] py-[1px] text-[9px] font-bold shrink-0"
    style={
      tone === 'gold'
        ? { background: 'rgba(245,184,0,0.12)', color: GOLD, border: '1px solid rgba(245,184,0,0.35)' }
        : { background: '#1b1c20', color: '#a3a8b1', border: '1px solid #2b2f36' }
    }
  >
    {children}
  </span>
);

const Badges = ({ p }: { p: PeerBPhone }) =>
  p.verified ? (
    <span className="flex gap-1 flex-wrap">
      {p.verified.kyc && (
        <Badge tone="gold">
          <BadgeCheck size={10} /> KYC Verified
        </Badge>
      )}
      {p.verified.x && <Badge tone="grey">X</Badge>}
      {p.verified.google && <Badge tone="grey">Google</Badge>}
    </span>
  ) : null;

const ServiceCard = ({
  p,
  now,
  inCall,
  onCall,
  onBook,
}: {
  p: PeerBPhone;
  now: number;
  inCall: boolean;
  onCall: (video: boolean) => void;
  onBook: () => void;
}) => {
  const { listing, rate } = p.profile;
  const name = serviceName(p);
  const status = openLabel(p, now);
  return (
    <article className="rounded-2xl border border-[#23262c] bg-[#121316] p-3 flex flex-col gap-2.5">
      <div className="flex items-start gap-3">
        <Avatar title={name} src={p.avatar} size={44} />
        <div className="flex-1 min-w-0">
          <div className={`text-[14px] font-semibold text-white ${CLIP}`}>{name}</div>
          <div className={`text-[12px] text-[#c9ccd1] ${CLIP}`}>{listing.title || categoryLabel(listing.category)}</div>
          <div className="mt-1">
            <Badges p={p} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[14px] font-bold" style={{ color: GOLD }}>
            {rate ? rateShort(rate) : 'Free'}
          </div>
          <div
            className="text-[11px] flex items-center justify-end gap-1"
            style={{ color: status.open ? GREEN : '#98A2B3' }}
          >
            {status.open && <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />}
            {status.text}
          </div>
        </div>
      </div>
      {listing.about && <p className="text-[12px] text-[#a3a8b1] leading-snug line-clamp-2">{listing.about}</p>}
      <div className="flex gap-2">
        <button
          className="flex-1 min-w-0 rounded-xl py-2 text-[13px] font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
          style={{ background: GOLD, color: '#1a1300' }}
          disabled={inCall}
          onClick={() => onCall(false)}
        >
          <Phone size={14} /> Call
        </button>
        <button
          className="flex-1 min-w-0 rounded-xl py-2 text-[13px] font-semibold flex items-center justify-center gap-1.5 border border-[#2b2f36] text-white disabled:opacity-40"
          disabled={inCall}
          onClick={() => onCall(true)}
        >
          <Video size={14} color={GOLD} /> Video
        </button>
        <button
          className="flex-1 min-w-0 rounded-xl py-2 text-[13px] font-semibold flex items-center justify-center gap-1.5 border border-[#2b2f36] text-white disabled:opacity-40"
          disabled={!listing.booking}
          title={listing.booking ? undefined : 'Not taking bookings'}
          onClick={onBook}
        >
          <CalendarClock size={14} color={GOLD} /> Book
        </button>
      </div>
    </article>
  );
};

/**
 * Chat › Calls › Services: everyone who has listed themselves in bPhone, with their rate, whether
 * they are open now, and Call / Video / Book. The call goes through the normal dial, which shows
 * the rate and asks for a max spend (QuoteSheet) before ringing. The list is fetched once by
 * CallsList (the search box uses it too) and filtered here by category chip.
 */
export const Directory = ({
  list,
  error,
  onListServices,
  onLeave,
}: {
  list: PeerBPhone[] | null;
  error: string;
  onListServices: () => void;
  onLeave?: () => void;
}) => {
  const { call } = useCalls();
  const [chip, setChip] = useState<ServiceChip>('all');
  const [booking, setBooking] = useState<PeerBPhone | null>(null);
  const inCall = busy(call);
  const now = Date.now();
  const shown = useMemo(() => (list ? servicesIn(list, chip) : null), [list, chip]);

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div
        role="radiogroup"
        aria-label="Category"
        className="flex gap-1.5 overflow-x-auto -mx-4 px-4"
        style={{ scrollbarWidth: 'none' }}
      >
        {SERVICE_CHIPS.map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={chip === c.id}
            onClick={() => setChip(c.id)}
            className="shrink-0 rounded-full px-3 py-[6px] text-[12px] font-semibold whitespace-nowrap"
            style={
              chip === c.id
                ? { background: GOLD, color: '#1a1300' }
                : { background: '#121316', color: '#a3a8b1', border: '1px solid #23262c' }
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      {shown === null && !error && (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin" color="#98A2B3" />
        </div>
      )}
      {error && <p className="text-xs text-[#ff6b6b]">{error}</p>}
      {shown && shown.length === 0 && !error && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-[#98A2B3]">No listings yet.</p>
          <button
            className="rounded-full px-4 py-2 text-[13px] font-semibold"
            style={{ background: GOLD, color: '#1a1300' }}
            onClick={onListServices}
          >
            List your services
          </button>
        </div>
      )}
      {shown?.map((p) => (
        <ServiceCard
          key={p.key}
          p={p}
          now={now}
          inCall={inCall}
          onCall={(video) => {
            void dial(peerOf(p), { video });
            onLeave?.();
          }}
          onBook={() => setBooking(p)}
        />
      ))}
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
