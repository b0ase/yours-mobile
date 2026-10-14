import { describe, expect, test } from 'bun:test';
import {
  OVERPAYMENT_TERM,
  allotmentMinute,
  excessRefundDue,
  excessSats,
  isExcessChoice,
  minuteRef,
  type MinuteInput,
} from './minute';
import { BSHARES_TICKER, nextStep, tickerLabel } from './placement';

// Illustrative figures only (not the real register).
const base: MinuteInput = {
  company: { name: 'Test Company Ltd', number: '00000000' },
  date: '2026-11-02',
  minuteNumber: 12,
  director: { name: 'Dee Rector', handle: 'dee' },
  allottee: { name: 'Ann Investor', handle: 'ann' },
  offer: {
    id: 'offer-1',
    offeredAt: '2026-10-20',
    closesAt: '2026-11-03',
    shares: 1_000,
    pricePence: 5,
    gbpPerBsvPence: 4_000,
    rateDate: '2026-10-20',
    sats: 125_000_000,
    lockMonths: 12,
  },
  payment: { txid: 'ab'.repeat(32), paidSats: 125_000_000, excessChoice: 'refund' },
  register: {
    nominalNanoPounds: 1_000,
    certificate: '012',
    holdingBefore: 9_000,
    issuedBefore: 90_000,
    authorised: 1_000_000,
  },
};

describe('overpayment term and choice', () => {
  test('the offer term is worded as decided', () => {
    expect(OVERPAYMENT_TERM).toBe(
      'Any excess is refunded in BSV within 14 days, unless you choose to have it treated as share premium.',
    );
  });
  test('choice is refund or premium only', () => {
    expect(isExcessChoice('refund')).toBe(true);
    expect(isExcessChoice('premium')).toBe(true);
    expect(isExcessChoice('loan')).toBe(false);
    expect(isExcessChoice(undefined)).toBe(false);
  });
  test('excess is never negative', () => {
    expect(excessSats(130, 100)).toBe(30);
    expect(excessSats(100, 100)).toBe(0);
    expect(excessSats(90, 100)).toBe(0);
  });
  test('a refund chosen shows as a pending director action until recorded', () => {
    const o = { status: 'approved' as const, excessChoice: 'refund' as const, excessSats: 5 };
    expect(excessRefundDue(o)).toBe(true);
    expect(nextStep(o, 'director')).toBe('Refund excess');
    expect(nextStep({ ...o, excessRefundTxid: 'cd'.repeat(32) }, 'director')).toBe('Issue share token');
    expect(nextStep({ ...o, excessChoice: 'premium' }, 'director')).toBe('Issue share token');
    expect(nextStep({ ...o, status: 'issued' }, 'director')).toBe('Refund excess');
    expect(nextStep(o, 'investor')).toBeNull();
  });
});

describe('allotment minute (round-2026-08 NDS format)', () => {
  test('reference and heading follow the precedent', () => {
    expect(minuteRef('2026-11-02', 12)).toBe('BCORP-BM-2026-11-02-012');
    expect(() => minuteRef('2 Nov', 1)).toThrow();
    const m = allotmentMinute(base);
    expect(m.ref).toBe('BCORP-BM-2026-11-02-012');
    expect(m.text).toContain('MINUTE OF A DECISION OF THE SOLE DIRECTOR');
    expect(m.text).toContain('made under section 248 of the Companies Act 2006');
    expect(m.text).toContain('Date: 2 November 2026 · Reference: BCORP-BM-2026-11-02-012');
    expect(m.text).toContain('Present: Dee Rector, sole director');
    expect(m.text).toContain('Retained under s.248 CA 2006 — not filed at Companies House');
  });
  test('allotment figures come from the inputs', () => {
    const t = allotmentMinute(base).text;
    expect(t).toContain('Shares allotted: 1,000 ordinary shares of £0.000001 each, fully paid');
    expect(t).toContain('Aggregate nominal value: £0.001');
    expect(t).toContain('Certificate number: 012');
    expect(t).toContain('Holding after allotment: 10,000 ordinary shares');
    expect(t).toContain('Issued capital after allotment: 91,000 ordinary shares');
    expect(t).toContain('Resulting percentage: 10.99%');
    expect(t).toContain('within the authorised limit of 1,000,000 ordinary shares under Article 19.1');
    expect(t).toContain('section 583');
    expect(t).toContain('on or before 2 December 2026');
    expect(t).toContain(OVERPAYMENT_TERM);
  });
  test('exact payment has no excess section; sections are numbered in order', () => {
    const t = allotmentMinute(base).text;
    expect(t).not.toContain('above the Offer');
    expect(t).toContain('1. Background');
    expect(t).toContain('2. The allotment');
    expect(t).toContain('3. Consideration is not cash');
    expect(t).toMatch(/5\.1 Enter the Subscriber in the register/);
  });
  test('excess as premium: worded like BCORP-BM-2026-10-03-010 §4', () => {
    const t = allotmentMinute({
      ...base,
      payment: { ...base.payment, paidSats: 130_000_000, excessChoice: 'premium' },
    }).text;
    expect(t).toContain('3. The payment of 0.05 BSV above the Offer');
    expect(t).toContain('being premium paid on those shares');
    expect(t).toContain('It is not refunded, is not a loan, and creates no right to further shares.');
    expect(t).toContain('Consideration: 1.3 BSV (£52.00)');
  });
  test('excess refunded: forms no part of the consideration, due in 14 days', () => {
    const t = allotmentMinute({ ...base, payment: { ...base.payment, paidSats: 130_000_000 } }).text;
    expect(t).toContain('chose to have the excess refunded');
    expect(t).toContain('on or before 16 November 2026');
    expect(t).toContain('Consideration: 1.25 BSV (£50.00)');
  });
  test('refuses an excess without a choice, and anything over the authorised ceiling', () => {
    expect(() =>
      allotmentMinute({ ...base, payment: { ...base.payment, paidSats: 130_000_000, excessChoice: null } }),
    ).toThrow();
    expect(() => allotmentMinute({ ...base, register: { ...base.register, issuedBefore: 999_500 } })).toThrow();
    expect(allotmentMinute({ ...base, register: { ...base.register, authorised: null } }).text).not.toContain(
      'Article 19.1',
    );
  });
});

describe('ticker', () => {
  test('bShares serves $bcorp', () => {
    expect(BSHARES_TICKER).toBe('bcorp');
    expect(tickerLabel()).toBe('$bcorp');
    expect(tickerLabel('BCORP')).toBe('$bcorp');
  });
});
