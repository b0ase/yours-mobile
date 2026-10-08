import { useEffect, useMemo, useState } from 'react';
import { deriveDepositAddresses } from '@1sat/actions';
import { CalendarClock, Loader2, Phone } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { walletHoldings } from '../chat/holdings';
import type { Holding } from '../chat/tokenRooms';
import { useAccountNames } from '../names/accountNames';
import { bareName } from '../names/names';
import { fmtSats, useBsvUsd, usdToSats } from '../money/money';
import { actBooking, bphoneEnabled, listBookings, loadMyProfile, saveMyProfile } from './bphone';
import { busy as callBusy, shortKey } from './machine';
import {
  ABOUT_MAX,
  BOOKING_STATUS_TEXT,
  bookingIsNow,
  CATEGORIES,
  DAYS,
  EMPTY_PROFILE,
  hoursLabel,
  listingProblem,
  minutesOf,
  PERS,
  PER_LABEL,
  rateLabel,
  rateShort,
  TITLE_MAX,
  upcomingBookings,
  WEEKDAYS_9_5,
  type AssetKind,
  type Booking,
  type BPhoneProfile,
  type Category,
  type RateAsset,
  type RateCard,
  type RatePer,
} from './rateCard';
import { dial } from './store';
import { useCalls } from './useCalls';

const GOLD = '#F5B800';
const f = (u: string, i?: RequestInit) => fetch(u, i);
const INPUT = 'rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none';

const Seg = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) => (
  <div role="radiogroup" className="flex rounded-full p-[3px] bg-[#121316] border border-[#1f2127]">
    {options.map((o) => (
      <button
        key={o.id}
        role="radio"
        aria-checked={value === o.id}
        onClick={() => onChange(o.id)}
        className="flex-1 rounded-full px-2 py-[6px] text-[12px] font-bold"
        style={value === o.id ? { background: GOLD, color: '#1a1300' } : { color: '#8a8f98' }}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const Toggle = ({
  on,
  onChange,
  label,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) => (
  <button
    className="flex items-center justify-between gap-3 py-2 w-full text-left"
    onClick={() => onChange(!on)}
    role="switch"
    aria-checked={on}
  >
    <span>
      <span className="text-sm font-semibold text-white block">{label}</span>
      {hint && <span className="text-[11px] text-[#98A2B3] block">{hint}</span>}
    </span>
    <span className="w-11 h-6 rounded-full relative shrink-0" style={{ background: on ? GOLD : '#2b2f36' }}>
      <span
        className="absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all"
        style={{ left: on ? 23 : 3 }}
      />
    </span>
  </button>
);

const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Chat › Calls › bPhone: set what a call with you costs, list yourself for people looking for a
 * professional, give your hours, and handle bookings. Saved to the paymail server under your
 * identity key (calls/bphone.ts), so it follows the wallet across devices. bWalletX only.
 */
export const BPhoneSettings = ({ onLeave }: { onLeave?: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress;
  const { paymail } = useAccountNames(identityAddress, '', '', false);
  const { call } = useCalls();
  const rate = useBsvUsd();

  const [profile, setProfile] = useState<BPhoneProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);
  const [charge, setCharge] = useState(false);
  const [asset, setAsset] = useState<AssetKind>('bsv');
  const [token, setToken] = useState<Holding | null>(null);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [amount, setAmount] = useState('');
  const [per, setPer] = useState<RatePer>('minute');
  const [days, setDays] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('17:00');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  /** My identity key (hex), the key bookings are filed under. */
  const [me, setMe] = useState('');

  const myKey = useMemo(() => apiContext?.wallet, [apiContext]);

  // Load my profile once the wallet is unlocked.
  useEffect(() => {
    if (!myKey) return;
    let live = true;
    void (async () => {
      const { publicKey } = await myKey.getPublicKey({ identityKey: true });
      const p = await loadMyProfile(f, publicKey.toLowerCase());
      if (!live) return;
      setMe(publicKey.toLowerCase());
      setProfile(p);
      setCharge(!!p.rate);
      if (p.rate) {
        setAsset(p.rate.asset.kind);
        setAmount(String(p.rate.amount));
        setPer(p.rate.per);
        if (p.rate.asset.kind === 'bsv21') {
          const a = p.rate.asset;
          setToken({ kind: 'bsv21', id: a.id, symbol: a.sym, dec: a.dec, amountRaw: '0' });
        }
      }
      setDays(new Set(p.listing.hours.map((w) => w.day)));
      if (p.listing.hours[0]) {
        setFrom(p.listing.hours[0].from);
        setTo(p.listing.hours[0].to);
      }
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [myKey]);

  useEffect(() => {
    if (asset !== 'bsv21' || holdings || !apiContext) return;
    void walletHoldings(apiContext)
      .then((h) => setHoldings(h.filter((x) => x.kind === 'bsv21')))
      .catch(() => setHoldings([]));
  }, [asset, holdings, apiContext]);

  const refreshBookings = async () => {
    if (!myKey) return;
    setBookings(await listBookings(f, myKey).catch(() => []));
  };
  useEffect(() => {
    if (loaded) void refreshBookings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const patchListing = (p: Partial<BPhoneProfile['listing']>) =>
    setProfile((x) => ({ ...x, listing: { ...x.listing, ...p } }));

  const card: RateCard | null = useMemo(() => {
    if (!charge) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    let a: RateAsset;
    if (asset === 'bsv') a = { kind: 'bsv' };
    else if (asset === 'mnee') a = { kind: 'mnee' };
    else if (token) a = { kind: 'bsv21', id: token.id, sym: token.symbol, dec: token.dec };
    else return null;
    return { amount: n, per, asset: a };
  }, [charge, amount, asset, per, token]);

  const hours = useMemo(
    () => (minutesOf(from) < minutesOf(to) ? [...days].sort().map((day) => ({ day, from, to })) : []),
    [days, from, to],
  );

  const save = async () => {
    if (!apiContext?.wallet) return;
    setProblem('');
    setNote('');
    if (charge && !card) return setProblem(asset === 'bsv21' && !token ? 'Pick a token' : 'Enter a price');
    const next: BPhoneProfile = { ...profile, rate: card, listing: { ...profile.listing, hours } };
    const bad = listingProblem(next);
    if (bad) return setProblem(bad);
    if (next.listing.listed && !paymail) return setProblem('Claim a bWallet paymail first so callers can pay you');
    setSaving(true);
    try {
      // Where MNEE / token payments land: my own deposit addresses, filled in here so callers never guess.
      if (next.rate?.asset.kind === 'mnee') {
        const d = await deriveDepositAddresses.execute(apiContext, { startIndex: 0, count: 1 });
        const address = d.derivations[0]?.address;
        if (!address) throw new Error('Could not derive an MNEE address');
        next.rate = { ...next.rate, asset: { kind: 'mnee', address } };
      } else if (next.rate?.asset.kind === 'bsv21') {
        const address = account?.addresses?.ordAddress;
        if (!address) throw new Error('No ordinals address for tokens');
        next.rate = { ...next.rate, asset: { ...next.rate.asset, address } };
      }
      const saved = await saveMyProfile(f, apiContext.wallet, next);
      setProfile(saved);
      setNote(saved.rate ? `Saved: ${rateLabel(saved.rate)}` : 'Saved: calls are free');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const act = async (b: Booking, action: 'confirm' | 'decline' | 'cancel') => {
    if (!myKey) return;
    setActing(b.id);
    try {
      await actBooking(f, myKey, b.id, action);
      await refreshBookings();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  };

  if (!bphoneEnabled())
    return <p className="text-sm text-[#98A2B3] text-center py-8">bPhone needs the bWallet paymail service.</p>;
  if (!loaded)
    return (
      <div className="flex justify-center py-8">
        <Loader2 size={20} className="animate-spin" color="#98A2B3" />
      </div>
    );

  const upcoming = upcomingBookings(bookings ?? [], Date.now());
  const satsNote =
    card?.asset.kind === 'bsv' && usdToSats(card.amount, rate) !== null
      ? ` ≈ ${fmtSats(usdToSats(card.amount, rate)!)}`
      : '';

  return (
    <div className="flex flex-col gap-4 pb-6">
      <section className="flex flex-col gap-2">
        <Toggle
          on={charge}
          onChange={setCharge}
          label="Charge to receive calls"
          hint="Callers see the price and agree to it before your phone rings. Off: calls are free."
        />
        {charge && (
          <>
            <Seg
              value={asset}
              onChange={setAsset}
              options={[
                { id: 'bsv', label: 'Dollars in BSV' },
                { id: 'mnee', label: 'MNEE' },
                { id: 'bsv21', label: 'Token' },
              ]}
            />
            {asset === 'bsv21' && (
              <select
                className={INPUT}
                value={token?.id ?? ''}
                onChange={(e) => setToken(holdings?.find((h) => h.id === e.target.value) ?? null)}
                aria-label="Token"
              >
                <option value="">
                  {holdings === null
                    ? 'Loading your tokens…'
                    : holdings.length
                      ? 'Pick a token you hold'
                      : 'You hold no BSV-21 tokens'}
                </option>
                {holdings?.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.symbol}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-2 items-center">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder={asset === 'bsv' ? '$ amount' : 'Amount'}
                className={`${INPUT} w-32`}
                aria-label="Price"
              />
              <span className="text-xs text-[#98A2B3]">per</span>
              <Seg value={per} onChange={setPer} options={PERS.map((p) => ({ id: p, label: PER_LABEL[p] }))} />
            </div>
            {card && (
              <p className="text-xs text-[#98A2B3]">
                {rateLabel(card)}
                {satsNote}. {card.asset.kind === 'bsv' ? 'Paid every 10 s' : 'Paid every 60 s'} while you talk; a call
                that stops paying ends after a short grace period.
              </p>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-[#1f2127] pt-3">
        <Toggle
          on={profile.listing.listed}
          onChange={(v) => patchListing({ listed: v })}
          label="List me in the bPhone directory"
          hint="People looking for a professional see your title, rate and hours. Off: only people who know your name can call."
        />
        <input
          value={profile.listing.title}
          onChange={(e) => patchListing({ title: e.target.value.slice(0, TITLE_MAX) })}
          placeholder="Title, e.g. CBT therapist, Employment solicitor"
          className={INPUT}
          aria-label="Listing title"
        />
        <select
          className={INPUT}
          value={profile.listing.category}
          onChange={(e) => patchListing({ category: e.target.value as Category })}
          aria-label="Category"
        >
          {CATEGORIES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <textarea
          value={profile.listing.about}
          onChange={(e) => patchListing({ about: e.target.value.slice(0, ABOUT_MAX) })}
          placeholder="What you offer, who it is for, languages, qualifications…"
          rows={3}
          className={INPUT}
          aria-label="About"
        />
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white">Hours</span>
          <span className="text-[11px] text-[#98A2B3]">{profile.listing.timezone}</span>
        </div>
        <div className="flex gap-1">
          {DAYS.map((d, i) => (
            <button
              key={d}
              onClick={() =>
                setDays((s) => {
                  const n = new Set(s);
                  if (n.has(i)) n.delete(i);
                  else n.add(i);
                  return n;
                })
              }
              aria-pressed={days.has(i)}
              className="flex-1 rounded-lg py-1 text-[11px] font-bold"
              style={
                days.has(i) ? { background: GOLD, color: '#1a1300' } : { border: '1px solid #2b2f36', color: '#8a8f98' }
              }
            >
              {d}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center text-xs text-[#98A2B3]">
          <input
            type="time"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={INPUT}
            aria-label="From"
          />
          to
          <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT} aria-label="To" />
          <button
            className="underline"
            onClick={() => {
              setDays(new Set(WEEKDAYS_9_5.map((w) => w.day)));
              setFrom('09:00');
              setTo('17:00');
            }}
          >
            Weekdays 9–5
          </button>
          <button className="underline" onClick={() => setDays(new Set())}>
            Any time
          </button>
        </div>
        <p className="text-[11px] text-[#98A2B3]">
          {hoursLabel(hours)}. Outside your hours you can still be called; the directory just says you are closed.
        </p>
        <Toggle
          on={profile.listing.booking}
          onChange={(v) => patchListing({ booking: v })}
          label="Take bookings"
          hint="Let people request a call at a time inside your hours. You confirm each one."
        />
      </section>

      {problem && <p className="text-xs text-[#ff6b6b]">{problem}</p>}
      {note && <p className="text-xs text-[#2ecc71]">{note}</p>}
      <button
        onClick={() => void save()}
        disabled={saving}
        className="rounded-xl py-3 font-semibold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      <section className="flex flex-col gap-2 border-t border-[#1f2127] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-white flex items-center gap-1.5">
            <CalendarClock size={15} color={GOLD} /> Bookings
          </span>
          <button className="text-xs text-[#8a8f98] underline" onClick={() => void refreshBookings()}>
            Refresh
          </button>
        </div>
        {bookings === null && <Loader2 size={16} className="animate-spin" color="#98A2B3" />}
        {bookings !== null && upcoming.length === 0 && <p className="text-xs text-[#98A2B3]">No upcoming bookings.</p>}
        {upcoming.map((b) => {
          const iAmCallee = b.calleeKey === me;
          const other = iAmCallee ? b.callerLabel || shortKey(b.callerKey) : b.calleeLabel || shortKey(b.calleeKey);
          const otherKey = iAmCallee ? b.callerKey : b.calleeKey;
          const live = bookingIsNow(b, Date.now());
          return (
            <div key={b.id} className="rounded-xl border border-[#2b2f36] p-3 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-white font-semibold truncate">{bareName(other)}</span>
                <span className="text-[11px] text-[#98A2B3]">{BOOKING_STATUS_TEXT[b.status]}</span>
              </div>
              <div className="text-[11px] text-[#98A2B3]">
                {when(b.at)} · {b.minutes} min{b.rate ? ` · ${rateShort(b.rate)}` : ' · free'}
                {iAmCallee ? ' · they call you' : ' · you call them'}
              </div>
              {b.note && <div className="text-xs text-[#c9ccd1]">{b.note}</div>}
              <div className="flex gap-2 pt-1">
                {iAmCallee && b.status === 'requested' && (
                  <>
                    <button
                      className="text-xs font-semibold rounded-lg px-3 py-1"
                      style={{ background: GOLD, color: '#1a1300' }}
                      disabled={acting === b.id}
                      onClick={() => void act(b, 'confirm')}
                    >
                      Confirm
                    </button>
                    <button
                      className="text-xs rounded-lg px-3 py-1 border border-[#2b2f36] text-white"
                      disabled={acting === b.id}
                      onClick={() => void act(b, 'decline')}
                    >
                      Decline
                    </button>
                  </>
                )}
                {live && !callBusy(call) && (
                  <button
                    className="text-xs font-semibold rounded-lg px-3 py-1 flex items-center gap-1"
                    style={{ background: '#2ecc71', color: '#06240f' }}
                    onClick={() => {
                      void dial({ key: otherKey, label: other, verified: false });
                      onLeave?.();
                    }}
                  >
                    <Phone size={12} /> Call now
                  </button>
                )}
                {(b.status === 'requested' || b.status === 'confirmed') && (
                  <button
                    className="text-xs text-[#8a8f98] underline ml-auto"
                    disabled={acting === b.id}
                    onClick={() => void act(b, 'cancel')}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
      <p className="text-[10px] text-[#5b6069]">
        Payments go straight from the caller&rsquo;s wallet to yours, every few seconds, with no middleman and no
        refunds. You are responsible for what you offer and for any licence, tax or confidentiality rules that apply to
        you.
      </p>
    </div>
  );
};

export default BPhoneSettings;
