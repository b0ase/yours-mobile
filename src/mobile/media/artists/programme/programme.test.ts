import { describe, expect, test } from 'bun:test';
import {
  accrueReferrals,
  artistSlug,
  isEarlyBacker,
  isFoundingArtist,
  rankArtists,
  rankScore,
  referralShare,
  SPONSOR_CAP_SATS_PER_ARTIST,
  SPONSOR_CAP_SATS_PER_MONTH,
  SPONSOR_PLAYS_PER_ARTIST,
  splitSale,
  sponsoredPlaysLeft,
  sponsorPlay,
} from './programme';

describe('rank formula', () => {
  const none = { payments30d: [], selfKeys: [], sponsoredPlays30d: 0 };
  test('zero is zero', () => expect(rankScore(none)).toBe(0));

  test('linear in money paid to the artist', () => {
    const one = rankScore({ ...none, payments30d: [{ payer: 'f', sats: 10_000 }] });
    const ten = rankScore({ ...none, payments30d: [{ payer: 'f', sats: 100_000 }] });
    expect(one).toBe(11_000);
    expect(ten).toBe(101_000);
    const artists = [
      { ...none, slug: 'small', payments30d: [{ payer: 'a', sats: 5_000 }] },
      { ...none, slug: 'big', payments30d: [{ payer: 'w', sats: 1_000_000 }] },
      {
        ...none,
        slug: 'mid',
        payments30d: [
          { payer: 'b', sats: 50_000 },
          { payer: 'c', sats: 50_000 },
        ],
      },
    ];
    expect(rankArtists(artists).map((x) => x.slug)).toEqual(['big', 'mid', 'small']);
  });

  test("the artist's own payments are left out", () => {
    const self = {
      payments30d: [
        { payer: 'me', sats: 1e9 },
        { payer: 'my-other-wallet', sats: 1e9 },
      ],
      selfKeys: ['me', 'my-other-wallet'],
      sponsoredPlays30d: 0,
    };
    expect(rankScore(self)).toBe(0);
    expect(rankScore({ ...self, payments30d: [...self.payments30d, { payer: 'fan', sats: 500 }] })).toBe(1500);
  });

  test('a new artist with sponsored plays only still ranks', () => {
    expect(rankScore({ ...none, sponsoredPlays30d: 200 })).toBeGreaterThan(0);
    expect(
      rankArtists([
        { ...none, slug: 'a' },
        { ...none, slug: 'b', sponsoredPlays30d: 3 },
      ])[0].slug,
    ).toBe('b');
  });

  test('ties order by slug', () => {
    expect(
      rankArtists([
        { ...none, slug: 'b' },
        { ...none, slug: 'a' },
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
  test('early backer = first 100 paying fans', () => {
    expect(isEarlyBacker(1)).toBe(true);
    expect(isEarlyBacker(100)).toBe(true);
    expect(isEarlyBacker(101)).toBe(false);
    expect(isEarlyBacker(0)).toBe(false);
  });
  test('slug', () => {
    expect(artistSlug('Vex Void!')).toBe('vex-void');
    expect(artistSlug('Ñandú  Band')).toBe('nandu-band');
    expect(artistSlug('!')).toBeNull();
  });
});
