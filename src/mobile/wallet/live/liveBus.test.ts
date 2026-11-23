import { afterEach, describe, expect, jest, test } from 'bun:test';
import { __liveState, __resetLive, noteBalance, reportSpend } from './liveBus';
import { displayedSats, PENDING_TTL_MS } from './liveLogic';

/** What the Wallet card shows for a fetched balance `base` (WalletCard: displayedSats). */
const shown = (base: number) => displayedSats(base, __liveState().pending);

const BEFORE = 102_370_000; // ~1.0237 BSV
const AFTER = BEFORE - 100_000_142; // 1 BSV + 1 sat marker + 141 sat fee went out; 1,720 change stayed
const PAY = 100_000_001; // the outputs to others the wallet announces (bwxLiveSpend)

afterEach(() => __resetLive());

describe('live balance after a payment (RB, scammerscartel.com, 23 Nov 2026: $0 until reload)', () => {
  test('the balance already fell before createAction returned: the spend is not taken off again', () => {
    __resetLive();
    noteBalance(BEFORE);
    // The card's 5 s poll ran while the payment was broadcasting: storage had already taken the spend in.
    noteBalance(AFTER);
    reportSpend({ sats: PAY, label: 'scammerscartel.com', txid: 'cbf391e9' });
    expect(__liveState().pending).toHaveLength(0);
    expect(shown(AFTER)).toBe(AFTER); // was 0, and stayed 0: the same number never re-ran noteBalance
    // One tick for the payment, named; the unexplained "sent" one gave way to it.
    const ticks = __liveState().ticks;
    expect(ticks).toHaveLength(1);
    expect(ticks[0].sats).toBe(-PAY);
    expect(ticks[0].label).toBe('scammerscartel.com');
  });

  test('the post-spend balance lands inside the grace: the pending spend goes at once', () => {
    __resetLive();
    noteBalance(BEFORE);
    reportSpend({ sats: PAY, label: 'scammerscartel.com', txid: 'cbf391e9' });
    expect(shown(BEFORE)).toBe(BEFORE - PAY); // ticks down at once, as designed
    noteBalance(AFTER); // a few hundred ms later
    expect(__liveState().pending).toHaveLength(0);
    expect(shown(AFTER)).toBe(AFTER);
  });

  test('a pending spend never hangs: it expires on its own after the ttl even with no new balance', () => {
    jest.useFakeTimers();
    try {
      __resetLive();
      noteBalance(1_000);
      reportSpend({ sats: 400, label: 'x' });
      expect(shown(1_000)).toBe(600);
      // No fetch changes the number (WalletCard calls noteBalance only on a change): the timer lets it go.
      jest.advanceTimersByTime(PENDING_TTL_MS - 1_000);
      expect(__liveState().pending).toHaveLength(1);
      jest.advanceTimersByTime(2_000);
      expect(__liveState().pending).toHaveLength(0);
      expect(shown(1_000)).toBe(1_000);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });
});
