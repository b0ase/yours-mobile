import { afterEach, describe, expect, jest, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  __liveState,
  __resetLive,
  liveBalanceSnapshot,
  liveCardSats,
  noteAccount,
  noteBalance,
  pageBsvSats,
  reportSessionSpend,
  reportSpend,
} from './liveBus';
import { nextReadSeq, publishBalanceRead } from '../../../utils/balanceReads';
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

  test('review of #558, L4: two quick payments that one fetch already shows are not taken off', () => {
    __resetLive();
    noteBalance(10_000);
    noteBalance(10_000 - 1_000 - 2_000 - 200); // both spends and their fees already in
    reportSpend({ sats: 1_000, label: 'a' });
    reportSpend({ sats: 2_000, label: 'b' });
    expect(shown(6_800)).toBe(6_800);
    expect(__liveState().pending).toHaveLength(0);
    expect(__liveState().ticks.map((t) => t.sats)).toEqual([-2_000, -1_000]);
  });

  test('review of #558, M3: an unrelated fall never swallows a later announced spend', () => {
    __resetLive();
    noteBalance(10_000);
    noteBalance(5_000); // spent on another device
    reportSpend({ sats: 1_000, label: 'a' }); // not yet in the fetched 5,000
    expect(shown(5_000)).toBe(4_000);
    noteBalance(3_900); // the next fetch has it
    expect(shown(3_900)).toBe(3_900);
  });

  test('review of #558, M3: another account starts afresh (no pending spend, fall or base carries over)', () => {
    __resetLive();
    noteBalance(10_000, { account: 'addrA' });
    reportSpend({ sats: 4_000, label: 'a' });
    noteBalance(2_000, { account: 'addrB' }); // the user switched accounts
    expect(__liveState().pending).toHaveLength(0);
    expect(shown(2_000)).toBe(2_000);
    expect(__liveState().ticks).toHaveLength(0); // no "sent 8,000" for the switch
  });

  test('review of #558, L8: an incoming payment with a spend inside the grace settles on the next same-value fetch', () => {
    jest.useFakeTimers();
    try {
      __resetLive();
      noteBalance(10_000);
      reportSpend({ sats: 1_000, label: 'a' });
      noteBalance(13_900); // +5,000 received, the spend and its fee already in, inside the grace
      expect(shown(13_900)).toBe(12_900);
      jest.advanceTimersByTime(1_600);
      noteBalance(13_900, { startedAt: Date.now() - 100 }); // a read begun after the spend: the same number
      expect(shown(13_900)).toBe(13_900);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 2: a same-number read that may predate the payment never drops it (card never reads high)', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000_000);
      __resetLive();
      noteBalance(10_000);
      const before = Date.now() - 50; // a refresh whose BSV read began before the spend
      reportSpend({ sats: 1_000, label: 'x' });
      jest.setSystemTime(1_002_000);
      noteBalance(10_000, { startedAt: before }); // it ends 2 s later with the old number
      expect(shown(10_000)).toBe(9_000);
      // Begun after the spend, but the same number the spend was announced against: still not proof.
      noteBalance(10_000, { startedAt: Date.now() - 10 });
      expect(shown(10_000)).toBe(9_000);
      // No start time (not a real read): nothing is dropped either.
      noteBalance(10_000);
      expect(__liveState().pending).toHaveLength(1);
      // The real post-payment number settles it.
      noteBalance(8_900, { startedAt: Date.now() });
      expect(shown(8_900)).toBe(8_900);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 2: a changed read that began before the spend keeps it until a later read', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(2_000_000);
      __resetLive();
      noteBalance(10_000);
      const before = Date.now();
      jest.setSystemTime(2_000_100);
      reportSpend({ sats: 1_000, label: 'x' });
      jest.setSystemTime(2_003_000);
      noteBalance(15_000, { startedAt: before }); // +5,000 received, read begun before the spend
      expect(shown(15_000)).toBe(14_000);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 2: only real reads reach the live balance; the card never feeds it its props', () => {
    __resetLive();
    publishBalanceRead({ sats: 10_000, startedAt: Date.now() });
    reportSpend({ sats: 1_000, label: 'x' });
    expect(__liveState().pending[0].base).toBe(10_000);
    const card = readFileSync(resolve(import.meta.dir, '..', 'WalletCard.tsx'), 'utf8');
    expect(card).not.toContain('noteBalance(');
    expect(card).toContain('useEffect(() => noteAccount(id), [id]);');
    const wallet = readFileSync(resolve(import.meta.dir, '../../../utils/wallet.ts'), 'utf8');
    // Published only after a successful answer, with when the read began.
    expect(wallet).toContain('sats: response.data ?? 0,\n    startedAt,');
    expect(wallet.indexOf('publishBalanceRead(read)')).toBeGreaterThan(
      wallet.indexOf("throw new Error(response.error || 'Failed to get balance')"),
    );
  });

  test('review of #558 round 2: a coincidental unrelated fall never absorbs a payment', () => {
    __resetLive();
    noteBalance(10_000);
    noteBalance(7_000); // 3,000 left elsewhere
    reportSpend({ sats: 2_000, label: 'a' });
    expect(shown(7_000)).toBe(5_000);
    __resetLive();
    noteBalance(10_000);
    noteBalance(9_000); // 1,000 left elsewhere
    reportSpend({ sats: 50, label: 'micro' });
    expect(shown(9_000)).toBe(8_950);
  });

  test('review of #558 round 2: a fall is matched only within about one createAction', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(3_000_000);
      __resetLive();
      noteBalance(10_000);
      noteBalance(8_900); // fell by a 1,000 payment + fee
      jest.setSystemTime(3_015_000); // 15 s later: not this payment's fall
      reportSpend({ sats: 1_000, label: 'late' });
      expect(shown(8_900)).toBe(7_900);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 2: a payment announced for another account never comes off this card', () => {
    __resetLive();
    noteAccount('addrA');
    noteBalance(10_000);
    reportSpend({ sats: 1_000, label: 'x', account: 'addrA' });
    noteAccount('addrB');
    noteBalance(3_000);
    reportSpend({ sats: 500, label: 'y', account: 'addrA' }); // A's payment announced just after the switch
    expect(__liveState().pending).toHaveLength(0);
    expect(shown(3_000)).toBe(3_000);
    reportSpend({ sats: 500, label: 'z', account: 'addrB' });
    expect(shown(3_000)).toBe(2_500);
  });

  test("review of #558 round 3: the wallet's own Send never comes off twice (card ~900, never 0, never 10,000)", () => {
    __resetLive();
    noteAccount('addrA');
    publishBalanceRead({ sats: 10_000, startedAt: Date.now() - 10, account: 'addrA' });
    // The Send screen's createAction announces the spend (bwxLiveSpend).
    reportSpend({ sats: 9_000, label: 'Sent', account: 'addrA' });
    // Whatever number the page holds now (its old one, or one it lowered itself), the card is the real read minus it.
    for (const prop of [10_000, 1_000]) expect(liveCardSats(__liveState(), prop, 'addrA')).toBe(1_000);
    // The post-send read settles on the real figure (fee included).
    publishBalanceRead({ sats: 900, startedAt: Date.now(), account: 'addrA' });
    expect(liveCardSats(__liveState(), 10_000, 'addrA')).toBe(900);
    // The page no longer lowers its own number after a send.
    const page = readFileSync(resolve(import.meta.dir, '../../../pages/BsvWallet.tsx'), 'utf8');
    expect(page).not.toContain('prev - totalSats / BSV_DECIMAL_CONVERSION');
    const card = readFileSync(resolve(import.meta.dir, '..', 'WalletCard.tsx'), 'utf8');
    expect(card).toContain('const shownSats = known ? liveCardSats(live, sats, liveAccount) : sats;');
  });

  test('review of #558 round 3: before any real read, or for another account, the card uses the page number', () => {
    __resetLive();
    noteAccount('addrA');
    expect(liveCardSats(__liveState(), 4_000, 'addrA')).toBe(4_000);
    publishBalanceRead({ sats: 10_000, startedAt: Date.now(), account: 'addrA' });
    expect(liveCardSats(__liveState(), 4_000, 'addrB')).toBe(4_000);
  });

  test('review of #558 round 3: a read for another account (answered after a switch) is ignored', () => {
    __resetLive();
    noteAccount('addrA');
    publishBalanceRead({ sats: 10_000, startedAt: Date.now(), account: 'addrA' });
    noteAccount('addrB');
    publishBalanceRead({ sats: 3_000, startedAt: Date.now(), account: 'addrB' });
    publishBalanceRead({ sats: 10_000, startedAt: Date.now() - 500, account: 'addrA' }); // A's late answer
    expect(__liveState().base).toBe(3_000);
    expect(__liveState().baseFor).toBe('addrB');
    expect(__liveState().ticks).toHaveLength(0); // no spurious "+7,000 received"
  });

  test('review of #558 round 3: a read begun before a payment that includes an unrelated equal fall keeps it', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(2_000_000);
      __resetLive();
      noteBalance(10_000, { startedAt: Date.now() - 10 });
      const readStart = Date.now();
      jest.setSystemTime(2_000_100);
      reportSpend({ sats: 1_000, label: 'x' });
      jest.setSystemTime(2_000_500);
      noteBalance(9_000, { startedAt: readStart }); // excludes the payment, includes 1,000 that left elsewhere
      expect(shown(9_000)).toBe(8_000);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 4: after a send the page shows the card number, and MAX / send-all wait for a fresh read', () => {
    __resetLive();
    noteAccount('addrA');
    publishBalanceRead({ sats: 10_000, startedAt: Date.now() - 10, account: 'addrA' });
    // No spend pending: the page's own number.
    expect(pageBsvSats(__liveState(), 10_000, 'addrA')).toBe(10_000);
    reportSpend({ sats: 9_000, label: 'Sent', account: 'addrA' });
    // The page still holds 10,000 until its next read: the asset row, picker and Send card show the card's 1,000.
    expect(pageBsvSats(__liveState(), 10_000, 'addrA')).toBe(1_000);
    expect(pageBsvSats(__liveState(), 10_000, 'addrA')).toBe(liveCardSats(__liveState(), 10_000, 'addrA'));
    const page = readFileSync(resolve(import.meta.dir, '../../../pages/BsvWallet.tsx'), 'utf8');
    // The send marks the page number stale and reads the balance at once, before the address sync.
    const sent = page.indexOf('setBalanceFresh(false);\n        void getAndSetBsvBalance();');
    expect(sent).toBeGreaterThan(0);
    expect(
      page.indexOf("refreshUtxos().catch((err) => console.error('[handleSendBsv] reconcile", sent),
    ).toBeGreaterThan(sent);
    // MAX and send-all refuse a stale number ("Updating balance…"): no 10,000 fill or confirmation.
    const max = page.slice(page.indexOf('const fillInputWithAllBsv = () => {'));
    expect(max.slice(0, 120)).toContain('if (!balanceFresh) {');
    expect(page).toContain('if (isSendAllBsv && !balanceFresh) {');
    // Every other BSV figure is the shared one.
    expect(page).toContain('balance={shownBsv}');
    expect(page).toContain('balance: shownBsv,');
    expect(page).toContain('balanceBsv={shownBsv}');
  });

  test('review of #558 round 4: a read tagged for X before any card mounts never becomes Y card number', () => {
    __resetLive();
    publishBalanceRead({ sats: 7_777, startedAt: Date.now(), account: 'X' });
    expect(__liveState().baseFor).toBe('X');
    noteAccount('Y');
    expect(liveCardSats(__liveState(), 5_000, 'Y')).toBe(5_000);
    // And Y's first read is not a "received" move from X's number.
    publishBalanceRead({ sats: 5_000, startedAt: Date.now(), account: 'Y' });
    expect(__liveState().ticks).toHaveLength(0);
    // An untagged read before the card mounts is still adopted by the first account.
    __resetLive();
    noteBalance(4_000);
    noteAccount('Z');
    expect(liveCardSats(__liveState(), 1, 'Z')).toBe(4_000);
  });

  test('review of #558 round 5: a read that began before a newer one answers late and is ignored everywhere', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(2_000_000);
      __resetLive();
      noteAccount('A');
      expect(publishBalanceRead({ sats: 10_000, startedAt: Date.now() - 20, account: 'A' })).toBe(true);
      const r1Start = Date.now() + 10; // R1 begins
      const r1Seq = nextReadSeq();
      jest.setSystemTime(2_000_100);
      reportSpend({ sats: 1_000, label: 'send2', account: 'A' }); // a second send after R1 began
      jest.setSystemTime(2_003_000);
      expect(publishBalanceRead({ sats: 8_900, startedAt: Date.now() - 500, account: 'A' })).toBe(true); // R2
      const ticksBefore = __liveState().ticks.length;
      // R1 (older, before send2) lands last: not published, so neither the card nor the page takes it.
      expect(publishBalanceRead({ sats: 10_000, startedAt: r1Start, account: 'A', seq: r1Seq })).toBe(false);
      expect(liveCardSats(__liveState(), 10_000, 'A')).toBe(8_900);
      expect(__liveState().ticks).toHaveLength(ticksBefore); // no false "+1,100 received"
      // A direct late note is ignored too.
      noteBalance(10_000, { startedAt: r1Start, seq: r1Seq });
      expect(__liveState().base).toBe(8_900);
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });

  test('review of #558 round 5: the page drops a stale read, now and when it answers after the timeout', () => {
    const page = readFileSync(resolve(import.meta.dir, '../../../pages/BsvWallet.tsx'), 'utf8');
    const fn = page.slice(page.indexOf('const getAndSetBsvBalance = async'));
    expect(fn).toContain('const pending = readWalletBalance();');
    expect(fn).toContain('if (!r.stale) applyBalance(r.sats);');
    expect(fn).toContain('pending.then(applyRead)');
    expect(fn).toContain('if (read.stale) return null;');
    expect(fn).not.toContain('pending.then(applyBalance)');
  });

  test('review of #558 round 5: the page follows only the balance part of the live state', async () => {
    __resetLive();
    noteAccount('A');
    publishBalanceRead({ sats: 10_000, startedAt: Date.now(), account: 'A' });
    reportSpend({ sats: 500, label: 'gun pack', origin: 'https://tokenblaster.lol', account: 'A' });
    const before = liveBalanceSnapshot();
    expect(liveBalanceSnapshot()).toBe(before);
    // A session meter report changes ticks and sessions only: the balance snapshot is the same object.
    const ok = await reportSessionSpend('tokenblaster.lol', {
      type: 'bwallet:session-spend',
      v: 1,
      session: 'gun',
      sats: 20,
      left: 400,
    });
    expect(ok).toBe(true);
    expect(liveBalanceSnapshot()).toBe(before);
    // A new pending spend does change it.
    reportSpend({ sats: 100, label: 'x', account: 'A' });
    expect(liveBalanceSnapshot()).not.toBe(before);
    const page = readFileSync(resolve(import.meta.dir, '../../../pages/BsvWallet.tsx'), 'utf8');
    expect(page).toContain('const live = useLiveBalance();');
    expect(page).not.toMatch(/\buseLive\(\)/);
  });

  test('review of #558 round 6: the device clock going back an hour never freezes the balance', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(10_000_000);
      __resetLive();
      noteAccount('A');
      const first = { sats: 10_000, startedAt: Date.now(), account: 'A', seq: nextReadSeq() };
      expect(publishBalanceRead(first)).toBe(true);
      jest.setSystemTime(10_000_000 - 60 * 60 * 1000); // the clock goes back an hour
      const second = { sats: 8_900, startedAt: Date.now(), account: 'A', seq: nextReadSeq() };
      expect(publishBalanceRead(second)).toBe(true);
      expect(__liveState().base).toBe(8_900);
      expect(liveCardSats(__liveState(), 10_000, 'A')).toBe(8_900);
      // The page side uses the same answer (readWalletBalance's stale flag is publishBalanceRead's result).
      const wallet = readFileSync(resolve(import.meta.dir, '../../../utils/wallet.ts'), 'utf8');
      expect(wallet).toContain('const seq = nextReadSeq();');
      expect(wallet).toContain('const stale = !publishBalanceRead(read);');
    } finally {
      __resetLive();
      jest.useRealTimers();
    }
  });
});
