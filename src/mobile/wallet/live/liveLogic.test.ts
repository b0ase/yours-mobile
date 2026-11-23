import { describe, expect, test } from 'bun:test';
import {
  addPending,
  alreadyInBalance,
  nextExpiryIn,
  allowRate,
  applySessionSpend,
  displayedSats,
  expirePending,
  fundedWithin,
  liveTicks,
  parseSessionSpend,
  pruneSessions,
  pushTick,
  reconcilePending,
  refreshDelay,
  tickText,
  tween,
  unexplainedDelta,
  type SessionCtx,
} from './liveLogic';

const msg = (o: Record<string, unknown> = {}) => ({
  type: 'bwallet:session-spend',
  v: 1,
  session: 'gun-1abc',
  sats: 27,
  left: 973,
  ...o,
});
const ctx = (o: Partial<SessionCtx> = {}): SessionCtx => ({
  origin: 'tokenblaster.lol',
  now: 1000,
  funded: 1000,
  name: 'TokenBlaster',
  ...o,
});

describe('ticker', () => {
  test('keeps newest three, drops duplicate txids and zero amounts', () => {
    let l = pushTick([], { id: 'a', sats: -27, label: 'x', at: 1, txid: 't1' });
    l = pushTick(l, { id: 'b', sats: -27, label: 'x', at: 2, txid: 't1' });
    expect(l.length).toBe(1);
    l = pushTick(l, { id: 'c', sats: 0, label: 'x', at: 3 });
    expect(l.length).toBe(1);
    for (const id of ['d', 'e', 'f']) l = pushTick(l, { id, sats: 5, label: '', at: 4 });
    expect(l.map((t) => t.id)).toEqual(['f', 'e', 'd']);
  });
  test('fades after the ttl', () => {
    const l = [{ id: 'a', sats: 1, label: '', at: 0 }];
    expect(liveTicks(l, 7_999).length).toBe(1);
    expect(liveTicks(l, 8_000).length).toBe(0);
  });
  test('text', () => {
    expect(tickText({ sats: -27, label: 'TokenBlaster' })).toBe('−27 sats · TokenBlaster');
    expect(tickText({ sats: 1500, label: '' })).toBe('+1,500 sats');
  });
});

describe('optimistic spends', () => {
  test('displayed balance subtracts pending, never below 0', () => {
    const p = addPending([], { id: 'a', sats: 100, at: 0, txid: 't' });
    expect(addPending(p, { id: 'b', sats: 100, at: 0, txid: 't' }).length).toBe(1);
    expect(addPending(p, { id: 'c', sats: 0, at: 0 }).length).toBe(1);
    expect(displayedSats(1000, p)).toBe(900);
    expect(displayedSats(50, p)).toBe(0);
  });
  test('a fresh balance drops spends older than the grace, ttl drops the rest', () => {
    const p = [
      { id: 'old', sats: 1, at: 0 },
      { id: 'new', sats: 1, at: 9_000 },
    ];
    expect(reconcilePending(p, 10_000).map((x) => x.id)).toEqual(['new']);
    expect(expirePending(p, 30_500).map((x) => x.id)).toEqual(['new']);
  });
  test('regression (RB, 23 Nov 2026): a fetch inside the grace that already shows the spend drops it', () => {
    // 1 BSV + 1 sat paid from ~1.0237 BSV; the post-spend balance (0.0237 BSV) lands 400 ms after the announcement.
    const p = addPending([], { id: 'pay', sats: 100_000_001, at: 10_000, base: 102_370_000 });
    const next = 102_370_000 - 100_000_142; // fee and the 1 sat marker included
    const kept = reconcilePending(p, 10_400, 1_500, next);
    expect(kept).toHaveLength(0);
    expect(displayedSats(next, kept)).toBe(next); // was 0 (taken off twice, clamped)
    // A fetch that started before the spend (balance not fallen yet) still keeps it.
    expect(reconcilePending(p, 10_400, 1_500, 102_370_000)).toHaveLength(1);
    // No base known: the grace rule alone, as before.
    expect(reconcilePending([{ id: 'x', sats: 5, at: 10_000 }], 10_400, 1_500, 0)).toHaveLength(1);
  });
  test('several pending spends: only those the fall covers, oldest first; grace-dropped ones count in the fall', () => {
    const p = [
      { id: 'a', sats: 100, at: 1_000, base: 1_000 },
      { id: 'b', sats: 50, at: 1_100, base: 900 },
    ];
    expect(reconcilePending(p, 1_200, 1_500, 900).map((x) => x.id)).toEqual(['b']);
    expect(reconcilePending(p, 1_200, 1_500, 850).map((x) => x.id)).toEqual([]);
    // 'a' is past the grace (in the balance): a fall of 100 is its own, so 'b' stays.
    expect(reconcilePending(p, 2_550, 1_500, 900).map((x) => x.id)).toEqual(['b']);
  });
  test('a spend announced after the balance already fell by it is not taken off again', () => {
    expect(alreadyInBalance({ sats: 100_000_142, at: 0 }, 100_000_001, 4_000)).toBe(true);
    expect(alreadyInBalance({ sats: 100, at: 0 }, 101, 4_000)).toBe(false);
    expect(alreadyInBalance({ sats: 200, at: 0 }, 100, 31_000)).toBe(false);
    expect(alreadyInBalance(null, 100, 0)).toBe(false);
  });
  test('the next expiry is the oldest spend plus the ttl, never negative', () => {
    expect(nextExpiryIn([], 0)).toBeNull();
    expect(
      nextExpiryIn(
        [
          { id: 'a', sats: 1, at: 1_000 },
          { id: 'b', sats: 1, at: 500 },
        ],
        1_000,
      ),
    ).toBe(29_500);
    expect(nextExpiryIn([{ id: 'a', sats: 1, at: 0 }], 99_000)).toBe(0);
  });
  test('unexplained delta: incoming, covered spend, unknown spend', () => {
    expect(unexplainedDelta(null, 5, 0)).toBe(0);
    expect(unexplainedDelta(1000, 1500, 0)).toBe(500);
    expect(unexplainedDelta(1000, 900, 100)).toBe(0);
    expect(unexplainedDelta(1000, 800, 100)).toBe(-100);
  });
});

describe('session-spend validation', () => {
  test('parses only well-formed messages', () => {
    expect(parseSessionSpend(msg())).not.toBeNull();
    expect(parseSessionSpend(msg({ v: 2 }))).toBeNull();
    expect(parseSessionSpend(msg({ type: 'other' }))).toBeNull();
    expect(parseSessionSpend(msg({ sats: -1 }))).toBeNull();
    expect(parseSessionSpend(msg({ sats: 1.5 }))).toBeNull();
    expect(parseSessionSpend(msg({ left: '9' }))).toBeNull();
    expect(parseSessionSpend(msg({ session: 'a b' }))).toBeNull();
    expect(parseSessionSpend(msg({ session: 'x'.repeat(65) }))).toBeNull();
    expect(parseSessionSpend(msg({ label: 'y'.repeat(41) }))).toBeNull();
    expect(parseSessionSpend(null)).toBeNull();
    expect(parseSessionSpend(msg({ label: 'gun\u0007' }))?.label).toBe('gun');
  });

  test('refused unless this wallet funded the origin', () => {
    const r = applySessionSpend({}, parseSessionSpend(msg())!, ctx({ funded: 0 }));
    expect(r.ok).toBe(false);
  });

  test('capped at what the wallet paid; can only go down', () => {
    let r = applySessionSpend({}, parseSessionSpend(msg({ left: 5000 }))!, ctx());
    expect(r.ok).toBe(true);
    const s = Object.values(r.state)[0];
    expect(s.left).toBe(1000);
    expect(s.ceiling).toBe(1000);
    r = applySessionSpend(r.state, parseSessionSpend(msg({ sats: 27, left: 990 }))!, ctx());
    expect(Object.values(r.state)[0].left).toBe(973);
    r = applySessionSpend(r.state, parseSessionSpend(msg({ sats: 0, left: 999 }))!, ctx());
    expect(Object.values(r.state)[0].left).toBe(973);
    expect(applySessionSpend(r.state, parseSessionSpend(msg({ sats: 5000, left: 0 }))!, ctx()).ok).toBe(false);
  });

  test('a new wallet payment tops the ceiling up by exactly that amount', () => {
    let r = applySessionSpend({}, parseSessionSpend(msg({ left: 500 }))!, ctx());
    r = applySessionSpend(r.state, parseSessionSpend(msg({ sats: 0, left: 1500 }))!, ctx({ funded: 2000 }));
    const s = Object.values(r.state)[0];
    expect(s.ceiling).toBe(2000);
    expect(s.left).toBe(1500);
  });

  test('origin-bound: same session id from another origin is a separate (unfunded) session', () => {
    const r = applySessionSpend({}, parseSessionSpend(msg())!, ctx());
    const r2 = applySessionSpend(
      r.state,
      parseSessionSpend(msg({ left: 0 }))!,
      ctx({ origin: 'evil.example', funded: 0 }),
    );
    expect(r2.ok).toBe(false);
    expect(Object.keys(r2.state).length).toBe(1);
  });

  test('left 0 ends the meter; idle meters are pruned', () => {
    let r = applySessionSpend({}, parseSessionSpend(msg())!, ctx());
    r = applySessionSpend(r.state, parseSessionSpend(msg({ sats: 0, left: 0 }))!, ctx());
    expect(Object.keys(r.state).length).toBe(0);
    r = applySessionSpend({}, parseSessionSpend(msg())!, ctx());
    expect(Object.keys(pruneSessions(r.state, 1000 + 10 * 60 * 1000)).length).toBe(0);
  });

  test('funded window and rate limit', () => {
    expect(
      fundedWithin(
        [
          { at: 0, sats: 100 },
          { at: 13 * 3600_000, sats: 50 },
        ],
        13 * 3600_000 + 1,
      ),
    ).toBe(50);
    const b = new Map();
    let ok = 0;
    for (let i = 0; i < 30; i++) if (allowRate(b, 'o', 5_000)) ok++;
    expect(ok).toBe(20);
    expect(allowRate(b, 'o', 6_000)).toBe(true);
    expect(allowRate(b, 'other', 5_000)).toBe(true);
  });
});

describe('schedule and tween', () => {
  test('refresh delay', () => {
    expect(refreshDelay({ visible: false, lastActivityAt: 0, now: 0, liveSessions: 1 })).toBeNull();
    expect(refreshDelay({ visible: true, lastActivityAt: 0, now: 1000, liveSessions: 0 })).toBe(5_000);
    expect(refreshDelay({ visible: true, lastActivityAt: 0, now: 200_000, liveSessions: 0 })).toBe(20_000);
    expect(refreshDelay({ visible: true, lastActivityAt: 0, now: 200_000, liveSessions: 2 })).toBe(5_000);
  });
  test('tween', () => {
    expect(tween(100, 0, 0)).toBe(100);
    expect(tween(100, 0, 1)).toBe(0);
    expect(tween(0, 100, 0.5)).toBe(88);
    expect(tween(0, 100, 2)).toBe(100);
  });
});
