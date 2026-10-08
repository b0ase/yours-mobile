import { describe, expect, test } from 'bun:test';
import {
  bookingSlots,
  calleeShouldHangUp,
  capReachedAtS,
  costForMinutes,
  decideMeterPayment,
  FIRST_PAYMENT_S,
  FOREVER_S,
  GRACE_S,
  hoursLabel,
  isOpenAt,
  localClock,
  maxSpendPresets,
  nextOpening,
  owedThrough,
  parseBooking,
  parseHours,
  parsePayNotice,
  parseProfile,
  parseRateCard,
  payNotice,
  rateLabel,
  rateShort,
  recordPayment,
  secondsLeftUnderCap,
  startMeter,
  upcomingBookings,
  WEEKDAYS_9_5,
  type Booking,
  type RateCard,
} from './rateCard';

const usdPerMin: RateCard = { amount: 2, per: 'minute', asset: { kind: 'bsv' } };
const mneePerHour: RateCard = { amount: 90, per: 'hour', asset: { kind: 'mnee' } };
const tokenPerSec: RateCard = {
  amount: 1,
  per: 'second',
  asset: { kind: 'bsv21', id: `${'a'.repeat(64)}_0`, sym: 'BOB', dec: 0 },
};
const flat: RateCard = { amount: 50, per: 'call', asset: { kind: 'bsv' } };

describe('rate card parsing', () => {
  test('accepts the three assets and rounds to the asset unit', () => {
    expect(parseRateCard({ amount: 2.005, per: 'minute', asset: { kind: 'bsv' } })).toEqual({
      amount: 2.01,
      per: 'minute',
      asset: { kind: 'bsv' },
    });
    expect(parseRateCard({ amount: 5, per: 'hour', asset: { kind: 'mnee' } })?.asset.kind).toBe('mnee');
    expect(parseRateCard({ amount: 3, per: 'call', asset: tokenPerSec.asset })).toEqual({
      ...tokenPerSec,
      amount: 3,
      per: 'call',
    });
  });
  test('rejects nonsense: no asset, zero, negative, unknown per, bad token id', () => {
    expect(parseRateCard(null)).toBeNull();
    expect(parseRateCard({ amount: 0, per: 'minute', asset: { kind: 'bsv' } })).toBeNull();
    expect(parseRateCard({ amount: -1, per: 'minute', asset: { kind: 'bsv' } })).toBeNull();
    expect(parseRateCard({ amount: 1, per: 'day', asset: { kind: 'bsv' } })).toBeNull();
    expect(parseRateCard({ amount: 1, per: 'minute', asset: { kind: 'bsv21', id: 'nope' } })).toBeNull();
    expect(parseRateCard({ amount: 1e9, per: 'minute', asset: { kind: 'bsv' } })).toBeNull();
  });
  test('a profile with a broken rate is a free profile, never a crash', () => {
    const p = parseProfile({
      rate: { amount: 'x' },
      listing: { listed: true, title: ' Therapist ', category: 'therapy', hours: 'x' },
    });
    expect(p.rate).toBeNull();
    expect(p.listing).toMatchObject({
      listed: true,
      title: 'Therapist',
      category: 'therapy',
      hours: [],
      booking: true,
    });
    expect(parseProfile(undefined).listing.listed).toBe(false);
  });
  test('hours: valid windows only, sorted, from < to', () => {
    expect(
      parseHours([
        { day: 5, from: '09:00', to: '17:00' },
        { day: 1, from: '10:00', to: '09:00' },
        { day: 7, from: '09:00', to: '17:00' },
        { day: 1, from: '9:00', to: '17:00' },
        { day: 1, from: '09:00', to: '12:30' },
      ]),
    ).toEqual([
      { day: 1, from: '09:00', to: '12:30' },
      { day: 5, from: '09:00', to: '17:00' },
    ]);
  });
});

describe('labels', () => {
  test('rate labels say the asset', () => {
    expect(rateLabel(usdPerMin)).toBe('$2.00 / min, paid in BSV');
    expect(rateLabel(mneePerHour)).toBe('90.00 MNEE / hour');
    expect(rateLabel(tokenPerSec)).toBe('1 BOB / sec');
    expect(rateLabel(flat)).toBe('$50.00 per call, paid in BSV');
    expect(rateShort(usdPerMin)).toBe('$2/min');
    expect(rateShort(mneePerHour)).toBe('90 MNEE/hr');
    expect(rateShort({ ...usdPerMin, amount: 0.5 })).toBe('$0.5/min');
  });
});

describe('pricing', () => {
  test('owed through N seconds rounds up to the smallest unit, no drift over an hour', () => {
    expect(owedThrough(usdPerMin, 10)).toBe(0.34); // 2/6 = 0.3333…
    expect(owedThrough(usdPerMin, 3600)).toBe(120);
    expect(owedThrough(mneePerHour, 60)).toBe(1.5);
    expect(owedThrough(tokenPerSec, 60)).toBe(60);
    expect(owedThrough(flat, 0)).toBe(50);
    expect(costForMinutes(usdPerMin, 30)).toBe(60);
  });
  test('max-spend presets are 15/30/60 minutes of the rate, deduplicated; flat = the price', () => {
    expect(maxSpendPresets(usdPerMin)).toEqual([30, 60, 120]);
    expect(maxSpendPresets(flat)).toEqual([50]);
    expect(maxSpendPresets({ ...usdPerMin, amount: 0.01 })).toEqual([0.15, 0.3, 0.6]);
  });
});

describe('meter (caller side)', () => {
  test('pays the first interval at once, then one interval ahead, exact to the cent', () => {
    let m = startMeter(usdPerMin, 120);
    let d = decideMeterPayment(m, 0);
    expect(d).toEqual({ ok: true, units: 0.34, seq: 1, throughS: 10 });
    m = recordPayment(m, d as Extract<typeof d, { ok: true }>, 'a'.repeat(64));
    expect(decideMeterPayment(m, 2)).toEqual({ ok: false, reason: 'not-due' });
    d = decideMeterPayment(m, 5); // 10 - 5 = LEAD_S → due
    expect(d).toEqual({ ok: true, units: 0.33, seq: 2, throughS: 20 }); // 0.67 owed through 20 s
    m = recordPayment(m, d as Extract<typeof d, { ok: true }>, null);
    expect(m.paidUnits).toBe(0.67);
    expect(m.lastTxid).toBe('a'.repeat(64));
    // Fast-forward a long call: the sum of payments equals the rate, never more.
    for (let i = 0; i < 358; i++) {
      const e = decideMeterPayment(m, m.paidThroughS - 5);
      if (!e.ok) throw new Error(e.reason);
      m = recordPayment(m, e, null);
    }
    expect(m.paidThroughS).toBe(3600);
    expect(m.paidUnits).toBe(120);
  });
  test('refuses to pass the cap and reports the seconds left', () => {
    let m = startMeter(usdPerMin, 1); // $1 = 30 s exactly (0.34 + 0.33 + 0.33)
    expect(capReachedAtS(m)).toBe(30);
    expect(secondsLeftUnderCap(m, 5)).toBe(25);
    expect(capReachedAtS(startMeter(usdPerMin, 0.99))).toBe(20);
    for (const at of [0, 6, 16]) {
      const d = decideMeterPayment(m, at);
      if (!d.ok) throw new Error(d.reason);
      m = recordPayment(m, d, null);
    }
    expect(m.paidUnits).toBe(1);
    expect(decideMeterPayment(m, 26)).toEqual({ ok: false, reason: 'cap' });
    expect(decideMeterPayment({ ...m, stopped: true }, 16)).toEqual({ ok: false, reason: 'stopped' });
    expect(decideMeterPayment({ ...m, paying: true }, 16)).toEqual({ ok: false, reason: 'paying' });
  });
  test('a flat price is paid once and lasts forever', () => {
    let m = startMeter(flat, 0);
    expect(m.maxUnits).toBe(50);
    const d = decideMeterPayment(m, 0);
    expect(d).toEqual({ ok: true, units: 50, seq: 1, throughS: FOREVER_S });
    m = recordPayment(m, d as Extract<typeof d, { ok: true }>, null);
    expect(decideMeterPayment(m, 5000)).toEqual({ ok: false, reason: 'not-due' });
    expect(secondsLeftUnderCap(m, 5000)).toBe(Infinity);
  });
  test('the cap is never below one interval, so a call can always start', () => {
    expect(startMeter(usdPerMin, 0.01).maxUnits).toBe(0.34);
  });
  test('MNEE pays by the minute', () => {
    const m = startMeter(mneePerHour, 45);
    expect(decideMeterPayment(m, 0)).toEqual({ ok: true, units: 1.5, seq: 1, throughS: 60 });
  });
});

describe('callee enforcement and receipts', () => {
  test('first payment within FIRST_PAYMENT_S, then GRACE_S past paid-through', () => {
    expect(calleeShouldHangUp(FIRST_PAYMENT_S, 0)).toBe(false);
    expect(calleeShouldHangUp(FIRST_PAYMENT_S + 1, 0)).toBe(true);
    expect(calleeShouldHangUp(29, 20)).toBe(false);
    expect(calleeShouldHangUp(20 + GRACE_S + 1, 20)).toBe(true);
    expect(calleeShouldHangUp(1e8, FOREVER_S)).toBe(false);
  });
  test('receipts round-trip and reject junk', () => {
    const n = payNotice(3, 0.34, 30, 'B'.repeat(64));
    expect(parsePayNotice(JSON.parse(JSON.stringify(n)))).toEqual({ ...n, txid: 'b'.repeat(64) });
    expect(parsePayNotice({ t: 'bphone.pay', seq: -1, units: 1, throughS: 1 })).toBeNull();
    expect(parsePayNotice({ t: 'other' })).toBeNull();
    expect(parsePayNotice({ t: 'bphone.pay', seq: 1, units: 1, throughS: 1, txid: 'zz' })?.txid).toBeNull();
  });
});

describe('availability', () => {
  // 2026-10-07 is a Wednesday. 12:00Z = 13:00 in London (BST), 08:00 in New York (EDT).
  const wedNoonZ = Date.parse('2026-10-07T12:00:00Z');
  test('local clock in a zone', () => {
    expect(localClock(wedNoonZ, 'Europe/London')).toEqual({ day: 3, minutes: 13 * 60 });
    expect(localClock(wedNoonZ, 'America/New_York')).toEqual({ day: 3, minutes: 8 * 60 });
    expect(localClock(wedNoonZ, 'Not/AZone')).toEqual({ day: 3, minutes: 12 * 60 });
  });
  test('open now inside a window, closed outside, always open with no hours', () => {
    expect(isOpenAt(WEEKDAYS_9_5, 'Europe/London', wedNoonZ)).toBe(true);
    expect(isOpenAt(WEEKDAYS_9_5, 'Asia/Tokyo', wedNoonZ)).toBe(false); // 21:00
    expect(isOpenAt([], 'Asia/Tokyo', wedNoonZ)).toBe(true);
    const sat = Date.parse('2026-10-10T12:00:00Z');
    expect(isOpenAt(WEEKDAYS_9_5, 'Europe/London', sat)).toBe(false);
  });
  test('next opening wraps around the week', () => {
    expect(nextOpening(WEEKDAYS_9_5, 'Asia/Tokyo', wedNoonZ)).toMatchObject({ day: 4, from: '09:00' });
    const friEvening = Date.parse('2026-10-09T20:00:00Z');
    expect(nextOpening(WEEKDAYS_9_5, 'Europe/London', friEvening)).toMatchObject({ day: 1, from: '09:00' });
    expect(nextOpening([], 'UTC', 0)).toBeNull();
  });
  test('hours label merges runs', () => {
    expect(hoursLabel(WEEKDAYS_9_5)).toBe('Mon–Fri 09:00–17:00');
    expect(hoursLabel([...WEEKDAYS_9_5, { day: 6, from: '10:00', to: '13:00' }])).toBe(
      'Mon–Fri 09:00–17:00 · Sat 10:00–13:00',
    );
    expect(hoursLabel([])).toBe('Any time');
  });
});

describe('bookings', () => {
  const booking = (over: Partial<Booking> = {}): Booking => ({
    id: 'b1',
    calleeKey: '02' + 'a'.repeat(64),
    callerKey: '02' + 'b'.repeat(64),
    callerLabel: '$bob',
    calleeLabel: '$alice',
    at: '2026-10-08T10:00:00.000Z',
    minutes: 30,
    note: '',
    status: 'confirmed',
    rate: usdPerMin,
    createdAt: '2026-10-07T00:00:00.000Z',
    ...over,
  });
  test('parse keeps a sane booking and drops junk', () => {
    expect(parseBooking(booking())).toEqual(booking());
    expect(parseBooking({ id: 'x' })).toBeNull();
    expect(parseBooking(booking({ status: 'weird' as never }))?.status).toBe('requested');
  });
  test('slots fall inside the hours for the whole duration and skip confirmed bookings', () => {
    const now = Date.parse('2026-10-07T12:00:00Z'); // Wed 13:00 London
    const slots = bookingSlots({ hours: WEEKDAYS_9_5, timezone: 'Europe/London' }, now, {
      days: 1,
      stepMin: 30,
      durationMin: 30,
      taken: [booking({ at: '2026-10-07T13:30:00.000Z' })], // 14:30 London
    });
    const london = (t: number) =>
      new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    expect(slots.map(london)).toEqual([
      '13:30',
      '14:00',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '12:30',
    ]);
    expect(slots[0]).toBeGreaterThanOrEqual(now + 15 * 60_000);
  });
  test('slots with no hours are every step, 15 minutes out', () => {
    const now = Date.parse('2026-10-07T12:07:00Z');
    const slots = bookingSlots({ hours: [], timezone: 'UTC' }, now, { days: 1, stepMin: 60 });
    expect(slots.length).toBe(24);
    expect(new Date(slots[0]).toISOString()).toBe('2026-10-07T13:00:00.000Z');
  });
  test('upcoming keeps live bookings in time order', () => {
    const now = Date.parse('2026-10-08T09:00:00Z');
    const list = [
      booking({ id: 'late', at: '2026-10-09T10:00:00.000Z' }),
      booking({ id: 'past', at: '2026-10-07T10:00:00.000Z' }),
      booking({ id: 'declined', status: 'declined' }),
      booking({ id: 'soon', status: 'requested' }),
    ];
    expect(upcomingBookings(list, now).map((b) => b.id)).toEqual(['soon', 'late']);
  });
});
