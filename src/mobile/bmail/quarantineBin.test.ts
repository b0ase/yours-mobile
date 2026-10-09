import { describe, expect, it } from 'vitest';
import {
  BIN_MS,
  binDaysLeft,
  emptyMail,
  isInBin,
  isLive,
  isQuarantined,
  isTrustedSender,
  purgeBin,
  restoreFlags,
  restoreFromBin,
  setFlags,
  trustSender,
  type Received,
} from './store';
import { mailSegments, safeHref } from './links';

const mail = (id: string, p: Partial<Received> = {}): Received => ({
  id,
  from: 'kSender',
  at: 1,
  verifiedSats: 1,
  env: { t: 'bmail', v: 1, id, from: 'kSender', to: 'kMe', at: 1, sealed: 'CIPHER' },
  ...p,
});

describe('bMail Bin', () => {
  it('delete stamps deletedAt; undo and restore clear it', () => {
    const s = { ...emptyMail(), received: [mail('a')] };
    const { next, prev } = setFlags(s, ['a'], { deleted: true }, 1000);
    expect(next.received[0].deletedAt).toBe(1000);
    expect(isInBin(next.received[0])).toBe(true);
    expect(restoreFlags(next, prev).received[0].deletedAt).toBeUndefined();
    const r = restoreFromBin(next, ['a']).received[0];
    expect(r.deleted).toBe(false);
    expect(r.deletedAt).toBeUndefined();
    expect(isLive(r)).toBe(true);
  });

  it('keeps content for 30 days, then erases it locally and drops it from the Bin', () => {
    const s = {
      ...emptyMail(),
      received: [mail('a', { deleted: true, deletedAt: 0, opened: { subject: 's', body: 'b' } })],
    };
    expect(purgeBin(s, BIN_MS - 1)).toBe(s);
    const r = purgeBin(s, BIN_MS).received[0];
    expect(r.erased).toBe(true);
    expect(r.opened).toBeUndefined();
    expect(r.env.sealed).toBe('');
    expect(r.verifiedSats).toBe(1); // the postage record stays: money is untouched
    expect(isInBin(r)).toBe(false);
    expect(restoreFromBin({ ...s, received: [r] }, ['a']).received[0].deleted).toBe(true);
  });

  it('old deleted mail without deletedAt starts its 30 days at the first purge', () => {
    const s = { ...emptyMail(), received: [mail('a', { deleted: true })] };
    const r = purgeBin(s, 5000).received[0];
    expect(r.deletedAt).toBe(5000);
    expect(r.erased).toBeUndefined();
  });

  it('binDaysLeft counts down from 30', () => {
    expect(binDaysLeft({ deletedAt: 0 }, 0)).toBe(30);
    expect(binDaysLeft({ deletedAt: 0 }, BIN_MS + 1)).toBe(0);
  });
});

describe('bMail Quarantine', () => {
  it('spam and blocked senders go to Quarantine, not Inbox; deleted mail goes to the Bin', () => {
    expect(isQuarantined(mail('a', { spam: true }))).toBe(true);
    expect(isQuarantined(mail('b'), ['kSender'])).toBe(true);
    expect(isLive(mail('b'), ['kSender'])).toBe(false);
    expect(isQuarantined(mail('c', { spam: true, deleted: true }))).toBe(false);
    expect(isQuarantined(mail('d'))).toBe(false);
  });

  it('trusting a sender unblocks them', () => {
    const s = trustSender({ ...emptyMail(), blocked: ['kSender'] }, 'kSender');
    expect(s.blocked).toEqual([]);
    expect(isTrustedSender(s, 'kSender')).toBe(true);
  });
});

describe('bMail link gating', () => {
  const body = 'See https://example.com/x and www.foo.io, or javascript:alert(1)';
  it('untrusted sender: links are text only', () => {
    const segs = mailSegments(body, false);
    expect(segs.some((x) => x.link)).toBe(true);
    expect(segs.every((x) => !x.href)).toBe(true);
  });
  it('trusted sender: http(s) links get an href', () => {
    const hrefs = mailSegments(body, true).flatMap((x) => (x.href ? [x.href] : []));
    expect(hrefs).toEqual(['https://example.com/x', 'https://www.foo.io/']);
  });
  it('trust needs a friend, a contact or an explicit trust; blocked overrides', () => {
    const s = { ...emptyMail(), contacts: ['kC'] };
    expect(isTrustedSender(s, 'kX')).toBe(false);
    expect(isTrustedSender(s, 'kC')).toBe(true);
    expect(isTrustedSender(s, 'kF', (k) => k === 'kF')).toBe(true);
    expect(isTrustedSender({ ...s, blocked: ['kC'] }, 'kC')).toBe(false);
  });
  it('safeHref refuses non-web schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,x')).toBeUndefined();
    expect(safeHref('https://a.com).')).toBe('https://a.com/');
  });
});
