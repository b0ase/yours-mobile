import { describe, expect, test } from 'bun:test';
import {
  accrueReferrals,
  artistSlug,
  isEarlyBacker,
  isFoundingArtist,
  lockPower,
  rankArtists,
  rankScore,
  referralShare,
  SPONSOR_CAP_SATS_PER_ARTIST,
  SPONSOR_CAP_SATS_PER_MONTH,
  SPONSOR_PLAYS_PER_ARTIST,
  splitSale,
  sponsoredPlaysLeft,
  sponsorPlay,
  suggestOwnLock,
} from './programme';

describe('rank formula', () => {
  test('zero is zero; more of anything ranks higher', () => {
    expect(rankScore({ plays30d: 0, fanLockPower: 0, ownLockPower: 0 })).toBe(0);
    const base = { plays30d: 100, fanLockPower: 1e6, ownLockPower: 0 };
    expect(rankScore({ ...base, plays30d: 200 })).toBeGreaterThan(rankScore(base));
    expect(rankScore({ ...base, fanLockPower: 2e6 })).toBeGreaterThan(rankScore(base));
    expect(rankScore({ ...base, ownLockPower: 1e5 })).toBeGreaterThan(rankScore(base));
  });

  test('documented value: 1,000 plays + 1M fan sat-days + 0 own', () => {
    // 0.5·2·log10(1001) + 0.35·log10(1000001) ≈ 3.0004 + 2.1
    expect(rankScore({ plays30d: 1000, fanLockPower: 1e6, ownLockPower: 0 })).toBeCloseTo(5.1004, 3);
  });

  test('one huge backer does not swamp real listening', () => {
    const listened = { slug: 'a', plays30d: 5000, fanLockPower: 1e5, ownLockPower: 0 };
    const whale = { slug: 'b', plays30d: 10, fanLockPower: 1e9, ownLockPower: 0 };
    expect(rankArtists([whale, listened])[0].slug).toBe('a');
  });

  test('lock power is sats × days left, never negative', () => {
    expect(lockPower(1000, 30)).toBe(30_000);
    expect(lockPower(1000, -2)).toBe(0);
  });

  test('ties order by slug', () => {
    const z = { plays30d: 1, fanLockPower: 0, ownLockPower: 0 };
    expect(
      rankArtists([
        { ...z, slug: 'b' },
        { ...z, slug: 'a' },
      ]).map((x) => x.slug),
    ).toEqual(['a', 'b']);
  });
});

describe('sponsorship caps', () => {
  test('caps allow the full first 1,000 plays per artist, even at the max play cost', () => {
    let st = { artistPlays: 0, artistSats: 0, monthSats: 0 };
    for (let i = 0; i < SPONSOR_PLAYS_PER_ARTIST; i++) {
      const d = sponsorPlay(st, 240);
      expect(d.ok).toBe(true);
      st = { artistPlays: st.artistPlays + 1, artistSats: st.artistSats + 240, monthSats: st.monthSats + 240 };
    }
    expect(st.artistSats).toBe(SPONSOR_CAP_SATS_PER_ARTIST);
    expect(sponsorPlay(st, 1)).toEqual({ ok: false, reason: 'artist-plays' });
    expect(SPONSOR_CAP_SATS_PER_ARTIST).toBe(240_000);
    expect(SPONSOR_CAP_SATS_PER_MONTH).toBe(24_000_000);
  });
  const s = { artistPlays: 0, artistSats: 0, monthSats: 0 };
  test('pays a normal play', () => expect(sponsorPlay(s, 180)).toEqual({ ok: true, sats: 180 }));
  test('stops at 1,000 plays', () => {
    expect(sponsorPlay({ ...s, artistPlays: SPONSOR_PLAYS_PER_ARTIST }, 10)).toEqual({
      ok: false,
      reason: 'artist-plays',
    });
    expect(sponsoredPlaysLeft(990)).toBe(10);
    expect(sponsoredPlaysLeft(2000)).toBe(0);
  });
  test('per-artist sats cap', () =>
    expect(sponsorPlay({ ...s, artistSats: SPONSOR_CAP_SATS_PER_ARTIST - 5 }, 10)).toEqual({
      ok: false,
      reason: 'artist-cap',
    }));
  test('monthly cap', () =>
    expect(sponsorPlay({ ...s, monthSats: SPONSOR_CAP_SATS_PER_MONTH }, 1)).toEqual({
      ok: false,
      reason: 'month-cap',
    }));
  test('rejects odd play costs', () => {
    expect(sponsorPlay(s, 0).ok).toBe(false);
    expect(sponsorPlay(s, 1.5).ok).toBe(false);
    expect(sponsorPlay(s, 10_000).ok).toBe(false);
  });
});

describe('sales split', () => {
  test('default 10% into the listener pot', () => expect(splitSale(10_000)).toEqual({ artist: 9000, pot: 1000 }));
  test('adjustable, clamped to 0–50%', () => {
    expect(splitSale(10_000, 25)).toEqual({ artist: 7500, pot: 2500 });
    expect(splitSale(10_000, 90)).toEqual({ artist: 5000, pot: 5000 });
    expect(splitSale(10_000, -5)).toEqual({ artist: 10_000, pot: 0 });
    expect(splitSale(10_000, 'x')).toEqual({ artist: 9000, pot: 1000 });
  });
  test('pot rounds down; nothing is lost', () => {
    const r = splitSale(999, 10);
    expect(r).toEqual({ artist: 900, pot: 99 });
    expect(r.artist + r.pot).toBe(999);
  });
});

describe('referrals', () => {
  const signup = new Date('2026-10-12T00:00:00Z');
  test('100% of our fee inside 12 months, nothing after', () => {
    expect(referralShare(50, signup, new Date('2027-10-11T23:59:59Z'))).toBe(50);
    expect(referralShare(50, signup, new Date('2027-10-12T00:00:00Z'))).toBe(0);
    expect(referralShare(50, signup, new Date('2026-10-11T00:00:00Z'))).toBe(0);
  });
  test('accrues per artist', () => {
    const owed = accrueReferrals([
      { artist: 'vexvoid', feeSats: 10, fanSignedUpAt: signup, feeAt: new Date('2026-11-01') },
      { artist: 'vexvoid', feeSats: 5, fanSignedUpAt: signup, feeAt: new Date('2026-12-01') },
      { artist: 'other', feeSats: 7, fanSignedUpAt: signup, feeAt: new Date('2028-01-01') },
    ]);
    expect(owed.get('vexvoid')).toBe(15);
    expect(owed.has('other')).toBe(false);
  });
});

describe('badges and slugs', () => {
  test('founding artist = first 100', () => {
    expect(isFoundingArtist(1)).toBe(true);
    expect(isFoundingArtist(100)).toBe(true);
    expect(isFoundingArtist(101)).toBe(false);
    expect(isFoundingArtist(0)).toBe(false);
  });
  test('early backer', () => {
    expect(isEarlyBacker(3, 200)).toBe(true);
    expect(isEarlyBacker(400, 10)).toBe(true);
    expect(isEarlyBacker(400, 40)).toBe(false);
  });
  test('own lock suggested once there is sales income', () => {
    expect(suggestOwnLock(50_000, false)).toBe(false);
    expect(suggestOwnLock(150_000, false)).toBe(true);
    expect(suggestOwnLock(150_000, true)).toBe(false);
  });
  test('slug', () => {
    expect(artistSlug('Vex Void!')).toBe('vex-void');
    expect(artistSlug('Ñandú  Band')).toBe('nandu-band');
    expect(artistSlug('!')).toBeNull();
  });
});
