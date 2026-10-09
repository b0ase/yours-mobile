/**
 * bPhone: charge to receive calls (docs/BPHONE-PLAN.md). PURE: no wallet, no network, no React.
 *
 * A callee publishes a rate card (what a call costs and in which asset) and, optionally, a
 * listing (title, what they offer, opening hours, whether they take bookings). A caller sees the
 * rate and a max-spend before the call rings, then pays as they go, wallet to wallet:
 *   - BSV: priced in US dollars (owner rule: price in dollars, pay in sats), paid every 10 s.
 *   - MNEE: dollars, paid every 60 s (each transfer carries an indexing fee).
 *   - A BSV-21 token (their own or anyone's): whole tokens, paid every 60 s.
 *   - "per call": one flat payment when the callee answers.
 * The caller's phone runs the meter (`decideMeterPayment`); the callee's phone enforces it: a call
 * whose next payment is overdue past the grace period is ended (`calleeShouldHangUp`). Receipts
 * travel over the call's own data channel (`PayNotice`); the money arrives through paymail.
 */

export type RatePer = 'second' | 'minute' | 'hour' | 'call';
export type AssetKind = 'bsv' | 'mnee' | 'bsv21';
/**
 * Where the money goes. BSV is paid to the callee's paymail (P2P, a fresh key per payment), so
 * BSV needs no address. MNEE and BSV-21 transfers go to an address: the callee's wallet fills in
 * its own MNEE deposit / ordinals address when it saves the rate card.
 */
export type RateAsset =
  | { kind: 'bsv' }
  | { kind: 'mnee'; address?: string }
  | { kind: 'bsv21'; id: string; sym: string; dec: number; address?: string };

export const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export interface RateCard {
  /** Price in the asset's display unit: USD for BSV, MNEE dollars, or whole tokens. */
  amount: number;
  per: RatePer;
  asset: RateAsset;
}

export const CATEGORIES = [
  ['therapy', 'Therapy & counselling'],
  ['legal', 'Legal advice'],
  ['medical', 'Health & medical'],
  ['finance', 'Finance, tax & accounting'],
  ['coaching', 'Coaching & tutoring'],
  ['tech', 'Tech & development'],
  ['creative', 'Creative & media'],
  ['other', 'Other'],
] as const;
export type Category = (typeof CATEGORIES)[number][0];
export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x[0] === c)?.[1] ?? 'Other';

/** One opening window on a weekday, in the listing's own time zone. `day`: 0 Sunday … 6 Saturday. */
export interface HoursWindow {
  day: number;
  /** "HH:MM" 24h. */
  from: string;
  to: string;
}

export interface Listing {
  /** Shown in the bPhone directory. Off: the rate still applies to anyone who calls you. */
  listed: boolean;
  /** "Therapist (CBT)", "Employment solicitor". */
  title: string;
  /** What you offer, up to 280 characters. */
  about: string;
  category: Category;
  /** Opening hours; empty = any time. */
  hours: HoursWindow[];
  /** IANA zone the hours are in, e.g. "Europe/London". */
  timezone: string;
  /** Accept scheduled calls (bookings). */
  booking: boolean;
}

export interface BPhoneProfile {
  v: 1;
  /** null: calls are free (the default). */
  rate: RateCard | null;
  listing: Listing;
  updatedAt: number;
  /** bMail: price to reach me in USD (absent = Penny post, 1¢). */
  mail?: { usd: number };
}

export const DEFAULT_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export const DEFAULT_LISTING: Listing = {
  listed: false,
  title: '',
  about: '',
  category: 'other',
  hours: [],
  timezone: DEFAULT_TIMEZONE,
  booking: true,
};

export const EMPTY_PROFILE: BPhoneProfile = { v: 1, rate: null, listing: DEFAULT_LISTING, updatedAt: 0 };

export const TITLE_MAX = 60;
export const ABOUT_MAX = 280;
/** Largest price per unit we accept, in the asset's display unit (a typo guard, not a policy). */
export const AMOUNT_MAX = 1_000_000;
export const PERS: RatePer[] = ['second', 'minute', 'hour', 'call'];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_ID_RE = /^[0-9a-f]{64}_\d+$/;

const isCategory = (c: unknown): c is Category => CATEGORIES.some((x) => x[0] === c);

export const parseAsset = (raw: unknown): RateAsset | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const address = typeof r.address === 'string' && ADDRESS_RE.test(r.address) ? r.address : undefined;
  if (r.kind === 'bsv') return { kind: 'bsv' };
  if (r.kind === 'mnee') return address ? { kind: 'mnee', address } : { kind: 'mnee' };
  if (r.kind === 'bsv21' && typeof r.id === 'string' && TOKEN_ID_RE.test(r.id)) {
    const dec = typeof r.dec === 'number' && Number.isInteger(r.dec) && r.dec >= 0 && r.dec <= 18 ? r.dec : 0;
    const sym = typeof r.sym === 'string' ? r.sym.trim().slice(0, 16) : '';
    return { kind: 'bsv21', id: r.id, sym: sym || 'tokens', dec, ...(address ? { address } : {}) };
  }
  return null;
};

/** Where a caller pays this card: the callee's paymail for BSV, the card's address for MNEE / tokens. */
export type PayTo = { paymail: string } | { address: string };

export const payToFor = (card: RateCard, calleePaymail: string | null): PayTo | null => {
  if (card.asset.kind === 'bsv') return calleePaymail ? { paymail: calleePaymail } : null;
  return card.asset.address ? { address: card.asset.address } : null;
};

/** A stored / fetched rate card, or null when it is missing or malformed (= free calls). */
export const parseRateCard = (raw: unknown): RateCard | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const asset = parseAsset(r.asset);
  const per = r.per;
  const amount = r.amount;
  if (!asset || !PERS.includes(per as RatePer)) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > AMOUNT_MAX) return null;
  return { amount: roundUnits(amount, assetDecimals(asset)), per: per as RatePer, asset };
};

export const parseHours = (raw: unknown): HoursWindow[] => {
  if (!Array.isArray(raw)) return [];
  const out: HoursWindow[] = [];
  for (const w of raw.slice(0, 21)) {
    const r = w && typeof w === 'object' ? (w as Record<string, unknown>) : null;
    if (!r) continue;
    const day = r.day;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) continue;
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || !TIME_RE.test(r.from) || !TIME_RE.test(r.to))
      continue;
    if (minutesOf(r.from) >= minutesOf(r.to)) continue;
    out.push({ day, from: r.from, to: r.to });
  }
  return out.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
};

export const parseListing = (raw: unknown): Listing => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    listed: r.listed === true,
    title: typeof r.title === 'string' ? r.title.trim().slice(0, TITLE_MAX) : '',
    about: typeof r.about === 'string' ? r.about.trim().slice(0, ABOUT_MAX) : '',
    category: isCategory(r.category) ? r.category : 'other',
    hours: parseHours(r.hours),
    timezone: typeof r.timezone === 'string' && validTimezone(r.timezone) ? r.timezone : DEFAULT_TIMEZONE,
    booking: r.booking !== false,
  };
};

/** Validates a stored / fetched profile field by field; anything odd falls back to the default. */
export const parseProfile = (raw: unknown): BPhoneProfile => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    v: 1,
    rate: parseRateCard(r.rate),
    listing: parseListing(r.listing),
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    ...parseMailPrice(r.mail),
  };
};

/** bMail price to reach me: 0–$100 in USD, else absent. */
export const parseMailPrice = (raw: unknown): { mail?: { usd: number } } => {
  const usd = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).usd : undefined;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd <= 100 ? { mail: { usd } } : {};
};

/** A listing that can go in the directory needs a title; a rate is not required (free consultations exist). */
export const listingProblem = (p: BPhoneProfile): string | null => {
  if (!p.listing.listed) return null;
  if (!p.listing.title) return 'Give your listing a title';
  return null;
};

// ── Pricing ─────────────────────────────────────────────────────────────────

/** How often the caller pays, per asset: BSV every 10 s; MNEE / tokens every 60 s (indexing fee per transfer). */
export const PAY_INTERVAL_S: Record<AssetKind, number> = { bsv: 10, mnee: 60, bsv21: 60 };
/** The caller pays the next interval this many seconds before the paid-through time. */
export const LEAD_S = 5;
/** The callee allows this long past paid-through before ending an unpaid call. */
export const GRACE_S = 10;
/** The first payment (or the flat per-call price) must land within this long of the answer. */
export const FIRST_PAYMENT_S = 20;
/** Warn the caller this long before their max spend ends the call. */
export const WARN_BEFORE_S = 30;
/** A whole-call price is "paid through" forever. */
export const FOREVER_S = 1e9;

export const perSeconds = (per: RatePer): number =>
  per === 'second' ? 1 : per === 'minute' ? 60 : per === 'hour' ? 3600 : 0;

/** Smallest unit of the display amount: cents for USD / MNEE, the token's decimals otherwise. */
export const assetDecimals = (asset: RateAsset): number => (asset.kind === 'bsv21' ? Math.min(asset.dec, 8) : 2);

export const roundUnits = (x: number, dec: number) => Math.round(x * 10 ** dec) / 10 ** dec;
/** Round up to the asset's smallest unit (never under-pay a price); float noise forgiven. */
export const ceilUnits = (x: number, dec: number) => Math.ceil(x * 10 ** dec - 1e-7) / 10 ** dec;

/** "USD, paid in BSV" / "MNEE" / the token symbol. */
export const assetLabel = (asset: RateAsset): string =>
  asset.kind === 'bsv' ? 'BSV' : asset.kind === 'mnee' ? 'MNEE' : asset.sym;

/** "$2.00" / "2.00 MNEE" / "5 SYM". */
export const amountLabel = (asset: RateAsset, units: number): string => {
  const dec = assetDecimals(asset);
  const n = units.toLocaleString('en-US', {
    minimumFractionDigits: asset.kind === 'bsv21' ? 0 : 2,
    maximumFractionDigits: dec,
  });
  if (asset.kind === 'bsv') return `$${n}`;
  if (asset.kind === 'mnee') return `${n} MNEE`;
  return `${n} ${asset.sym}`;
};

export const PER_LABEL: Record<RatePer, string> = { second: 'sec', minute: 'min', hour: 'hour', call: 'call' };

/** "$2.00 / min", "20 MNEE / hour", "$50 per call", with "paid in BSV" for dollar prices. */
export const rateLabel = (card: RateCard, withAsset = true): string => {
  const a = amountLabel(card.asset, card.amount);
  const base = card.per === 'call' ? `${a} per call` : `${a} / ${PER_LABEL[card.per]}`;
  return withAsset && card.asset.kind === 'bsv' ? `${base}, paid in BSV` : base;
};

/** Short form for lists: "$2/min", "20 MNEE/hr", "$50/call". */
export const rateShort = (card: RateCard): string => {
  const dec = assetDecimals(card.asset);
  const n = roundUnits(card.amount, dec);
  const num = Number.isInteger(n) ? String(n) : n.toFixed(dec).replace(/0+$/, '');
  const a = card.asset.kind === 'bsv' ? `$${num}` : `${num} ${assetLabel(card.asset)}`;
  const per = card.per === 'hour' ? 'hr' : card.per === 'second' ? 's' : PER_LABEL[card.per];
  return `${a}/${per}`;
};

/** Total owed for the first `seconds` of a call, rounded up to the asset's smallest unit (flat price: the price). */
export const owedThrough = (card: RateCard, seconds: number): number => {
  if (card.per === 'call') return card.amount;
  const s = Math.max(0, seconds);
  return ceilUnits((card.amount * s) / perSeconds(card.per), assetDecimals(card.asset));
};

/** What `minutes` of call cost (for the quote sheet and the cap presets). */
export const costForMinutes = (card: RateCard, minutes: number): number => owedThrough(card, minutes * 60);

export const payInterval = (card: RateCard): number => PAY_INTERVAL_S[card.asset.kind];

/**
 * Max-spend choices for the quote sheet: 15, 30 and 60 minutes at this rate (a flat price has one
 * choice, the price). Never below one interval's charge, so the call can start.
 */
export const maxSpendPresets = (card: RateCard): number[] => {
  if (card.per === 'call') return [card.amount];
  const one = owedThrough(card, payInterval(card));
  const dec = assetDecimals(card.asset);
  const set = [15, 30, 60].map((m) => Math.max(one, ceilUnits(costForMinutes(card, m), dec)));
  return [...new Set(set)];
};

// ── Meter: the caller's pay-as-you-go state ────────────────────────────────

export interface Meter {
  card: RateCard;
  /** The most the caller agreed to spend, in the card's units. */
  maxUnits: number;
  paidUnits: number;
  /** Receipts sent so far; each payment gets the next number (idempotent on the far side). */
  seq: number;
  /** The call is paid up to this many seconds after it was answered (FOREVER_S once a flat price is paid). */
  paidThroughS: number;
  lastTxid: string | null;
  /** Set when the cap is hit or the caller stops paying; nothing more is sent. */
  stopped: boolean;
  /** A payment is in flight (so the loop never sends two at once). */
  paying: boolean;
}

export const startMeter = (card: RateCard, maxUnits: number): Meter => ({
  card,
  maxUnits: card.per === 'call' ? card.amount : Math.max(maxUnits, owedThrough(card, payInterval(card))),
  paidUnits: 0,
  seq: 0,
  paidThroughS: 0,
  lastTxid: null,
  stopped: false,
  paying: false,
});

export type MeterDecision =
  | { ok: true; units: number; seq: number; throughS: number }
  | { ok: false; reason: 'not-due' | 'cap' | 'stopped' | 'paying' };

/**
 * Is a payment due at `elapsedS` seconds into the call, and for how much? Pays one interval ahead
 * (LEAD_S before paid-through runs out), charging exactly what the rate owes through the new
 * paid-through time minus what was paid, so rounding never drifts over a long call. Refuses
 * anything that would take the total past the cap.
 */
export const decideMeterPayment = (m: Meter, elapsedS: number): MeterDecision => {
  if (m.stopped) return { ok: false, reason: 'stopped' };
  if (m.paying) return { ok: false, reason: 'paying' };
  if (m.card.per === 'call') {
    if (m.paidUnits > 0) return { ok: false, reason: 'not-due' };
    return m.card.amount > m.maxUnits
      ? { ok: false, reason: 'cap' }
      : { ok: true, units: m.card.amount, seq: m.seq + 1, throughS: FOREVER_S };
  }
  if (m.paidThroughS - elapsedS > LEAD_S) return { ok: false, reason: 'not-due' };
  const throughS = Math.max(m.paidThroughS, elapsedS) + payInterval(m.card);
  const units = roundUnits(owedThrough(m.card, throughS) - m.paidUnits, assetDecimals(m.card.asset));
  if (units <= 0) return { ok: true, units: 0, seq: m.seq, throughS }; // a free stretch (rounding): extend only
  if (m.paidUnits + units > m.maxUnits + 1e-9) return { ok: false, reason: 'cap' };
  return { ok: true, units, seq: m.seq + 1, throughS };
};

export const recordPayment = (m: Meter, d: Extract<MeterDecision, { ok: true }>, txid: string | null): Meter => ({
  ...m,
  paidUnits: roundUnits(m.paidUnits + d.units, assetDecimals(m.card.asset)),
  seq: d.seq,
  paidThroughS: d.throughS,
  lastTxid: txid ?? m.lastTxid,
  paying: false,
});

/** Seconds into the call at which the cap stops payments (FOREVER_S for a flat price). */
export const capReachedAtS = (m: Meter): number => {
  if (m.card.per === 'call') return FOREVER_S;
  // Whole intervals the cap affords from the start of the call, by the same rounding the meter uses.
  const interval = payInterval(m.card);
  let k = Math.floor(((m.maxUnits + 1e-9) * perSeconds(m.card.per)) / m.card.amount / interval);
  while (k > 0 && owedThrough(m.card, k * interval) > m.maxUnits + 1e-9) k--;
  return Math.max(m.paidThroughS, k * interval);
};

/** Seconds of call left under the cap at `elapsedS` (Infinity for a flat price). */
export const secondsLeftUnderCap = (m: Meter, elapsedS: number): number =>
  m.card.per === 'call' ? Infinity : Math.max(0, capReachedAtS(m) - elapsedS);

/**
 * Callee side: end the call when the caller has not paid for the time being used. The first
 * payment must arrive within FIRST_PAYMENT_S of the answer; after that, GRACE_S past paid-through.
 */
export const calleeShouldHangUp = (elapsedS: number, paidThroughS: number): boolean =>
  paidThroughS <= 0 ? elapsedS > FIRST_PAYMENT_S : elapsedS > paidThroughS + GRACE_S;

/** Receipt sent over the call's data channel after each payment. */
export interface PayNotice {
  t: 'bphone.pay';
  seq: number;
  units: number;
  throughS: number;
  txid: string | null;
}

export const payNotice = (seq: number, units: number, throughS: number, txid: string | null): PayNotice => ({
  t: 'bphone.pay',
  seq,
  units,
  throughS,
  txid,
});

export const parsePayNotice = (raw: unknown): PayNotice | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || r.t !== 'bphone.pay') return null;
  const { seq, units, throughS, txid } = r;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) return null;
  if (typeof throughS !== 'number' || !Number.isFinite(throughS) || throughS < 0) return null;
  const id = typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid) ? txid.toLowerCase() : null;
  return { t: 'bphone.pay', seq, units, throughS, txid: id };
};

// ── Availability ────────────────────────────────────────────────────────────

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const validTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The weekday and minute-of-day in `timezone` at `now` (ms). */
export const localClock = (now: number, timezone: string): { day: number; minutes: number } => {
  let tz = timezone;
  if (!validTimezone(tz)) tz = 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = DAY_INDEX[get('weekday')] ?? 0;
  const hour = Number(get('hour')) % 24;
  return { day, minutes: hour * 60 + Number(get('minute')) };
};

/** Inside one of the opening windows now? No windows = always available. */
export const isOpenAt = (hours: HoursWindow[], timezone: string, now: number): boolean => {
  if (hours.length === 0) return true;
  const c = localClock(now, timezone);
  return hours.some((w) => w.day === c.day && c.minutes >= minutesOf(w.from) && c.minutes < minutesOf(w.to));
};

/** The next window that opens after `now` (ms), or null when there are no hours. */
export const nextOpening = (
  hours: HoursWindow[],
  timezone: string,
  now: number,
): { day: number; from: string } | null => {
  if (hours.length === 0) return null;
  const c = localClock(now, timezone);
  const key = (d: number, m: number) => d * 1440 + m;
  const here = key(c.day, c.minutes);
  const sorted = [...hours].sort((a, b) => key(a.day, minutesOf(a.from)) - key(b.day, minutesOf(b.from)));
  return sorted.find((w) => key(w.day, minutesOf(w.from)) > here) ?? sorted[0];
};

/** "Mon–Fri 09:00–17:00 · Sat 10:00–13:00" (runs of consecutive days with the same window are merged). */
export const hoursLabel = (hours: HoursWindow[]): string => {
  if (hours.length === 0) return 'Any time';
  const sorted = parseHours(hours);
  const runs: { from: number; to: number; win: string }[] = [];
  for (const w of sorted) {
    const win = `${w.from}–${w.to}`;
    const last = runs[runs.length - 1];
    if (last && last.win === win && last.to === w.day - 1) last.to = w.day;
    else runs.push({ from: w.day, to: w.day, win });
  }
  return runs.map((r) => `${DAYS[r.from]}${r.to > r.from ? `–${DAYS[r.to]}` : ''} ${r.win}`).join(' · ');
};

/** Presets for the hours editor. */
export const WEEKDAYS_9_5: HoursWindow[] = [1, 2, 3, 4, 5].map((day) => ({ day, from: '09:00', to: '17:00' }));

// ── Bookings (scheduled calls) ──────────────────────────────────────────────

export type BookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled';
export const BOOKING_MINUTES = [15, 30, 45, 60] as const;

export interface Booking {
  id: string;
  calleeKey: string;
  callerKey: string;
  callerLabel: string;
  calleeLabel: string;
  /** Start, ISO 8601 UTC. */
  at: string;
  minutes: number;
  note: string;
  status: BookingStatus;
  /** The rate at the time of booking (what the caller agreed to), or null for a free call. */
  rate: RateCard | null;
  createdAt: string;
}

const STATUSES: BookingStatus[] = ['requested', 'confirmed', 'declined', 'cancelled'];

export const parseBooking = (raw: unknown): Booking | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.id !== 'string' || typeof r.calleeKey !== 'string' || typeof r.callerKey !== 'string') return null;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  const minutes = typeof r.minutes === 'number' && Number.isInteger(r.minutes) && r.minutes > 0 ? r.minutes : 30;
  return {
    id: r.id,
    calleeKey: r.calleeKey,
    callerKey: r.callerKey,
    callerLabel: typeof r.callerLabel === 'string' ? r.callerLabel : '',
    calleeLabel: typeof r.calleeLabel === 'string' ? r.calleeLabel : '',
    at: new Date(r.at).toISOString(),
    minutes,
    note: typeof r.note === 'string' ? r.note.slice(0, ABOUT_MAX) : '',
    status: STATUSES.includes(r.status as BookingStatus) ? (r.status as BookingStatus) : 'requested',
    rate: parseRateCard(r.rate),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
  };
};

/**
 * Bookable start times over the next `days`, every `stepMin` minutes, that sit inside the
 * callee's opening hours (in their zone) for the whole `durationMin`. No hours = every slot.
 * Returns epoch ms, ascending. Slots already taken by a confirmed booking are left out.
 */
export const bookingSlots = (
  listing: Pick<Listing, 'hours' | 'timezone'>,
  now: number,
  opts: { days?: number; stepMin?: number; durationMin?: number; taken?: Booking[] } = {},
): number[] => {
  const { days = 7, stepMin = 30, durationMin = 30, taken = [] } = opts;
  const step = stepMin * 60_000;
  const start = Math.ceil((now + 15 * 60_000) / step) * step; // at least 15 min notice, on a step
  const end = now + days * 86_400_000;
  const busy = taken
    .filter((b) => b.status === 'confirmed')
    .map((b) => ({ from: Date.parse(b.at), to: Date.parse(b.at) + b.minutes * 60_000 }));
  const out: number[] = [];
  for (let t = start; t < end; t += step) {
    if (listing.hours.length > 0) {
      const a = localClock(t, listing.timezone);
      const b = localClock(t + durationMin * 60_000 - 1, listing.timezone);
      const fits = listing.hours.some(
        (w) =>
          w.day === a.day && a.minutes >= minutesOf(w.from) && (b.day === a.day ? b.minutes < minutesOf(w.to) : false),
      );
      if (!fits) continue;
    }
    const clash = busy.some((x) => t < x.to && t + durationMin * 60_000 > x.from);
    if (!clash) out.push(t);
  }
  return out;
};

export const upcomingBookings = (list: Booking[], now: number): Booking[] =>
  list
    .filter(
      (b) => (b.status === 'requested' || b.status === 'confirmed') && Date.parse(b.at) + b.minutes * 60_000 > now,
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

/** A booked call may be dialled from 5 minutes before its start until it would have ended. */
export const bookingIsNow = (b: Booking, now: number): boolean => {
  const at = Date.parse(b.at);
  return b.status === 'confirmed' && now >= at - 5 * 60_000 && now <= at + b.minutes * 60_000;
};

export const BOOKING_STATUS_TEXT: Record<BookingStatus, string> = {
  requested: 'Requested',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
};
