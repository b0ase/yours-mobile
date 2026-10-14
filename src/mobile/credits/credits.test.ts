import { describe, expect, test } from 'bun:test';
import {
  CREDITS_TERMS_FALLBACK,
  MAX_TOP_UP_PENCE,
  addPending,
  canAskFromCredits,
  creditsForPence,
  depositOutcome,
  depositRequests,
  depositScriptHex,
  entryAmount,
  entryLabel,
  fmtCredits,
  fmtPence,
  lowBalanceText,
  parseCreditsInfo,
  parseLedger,
  parsePounds,
  penceToSats,
  planTopUp,
  prunePending,
  removePending,
  satsToPence,
  spentSoFar,
} from './credits';
import { lowBalanceOf, parseCreditsReply } from './agentCredits';
import { parseGeckoGbp } from './rate';

const TREASURY = '192nuX6cz81MH3T2gwsam3FxYoDrvzDYpU';
const REF = 'bcredits:0123456789abcdef01234567';
const live = {
  enabled: true,
  name: 'bCredits',
  issuer: 'b',
  treasury: TREASURY,
  pencePerCredit: 1,
  topupCapPence: 2000,
  markup: 1.35,
  depositReference: REF,
  terms: 'server terms',
  balance: 1250,
};

describe('config', () => {
  test('off / malformed reads as coming soon', () => {
    expect(parseCreditsInfo(null).enabled).toBe(false);
    expect(parseCreditsInfo({ ...live, enabled: false }).enabled).toBe(false);
    expect(parseCreditsInfo({ ...live, treasury: 'not-an-address' }).enabled).toBe(false);
    expect(parseCreditsInfo({ ...live, depositReference: 'bcredits:XYZ' }).enabled).toBe(false);
  });
  test('live config', () => {
    const i = parseCreditsInfo(live);
    expect(i).toMatchObject({ enabled: true, treasury: TREASURY, balance: 1250, markup: 1.35, terms: 'server terms' });
    expect(i.agentTurn).toBe(false);
    expect(parseCreditsInfo({ ...live, agentTurn: true }).agentTurn).toBe(true);
  });
  test('cap never above £20, whatever the server says', () => {
    expect(parseCreditsInfo({ ...live, topupCapPence: 100_000 }).topupCapPence).toBe(MAX_TOP_UP_PENCE);
    expect(parseCreditsInfo({ ...live, topupCapPence: 500 }).topupCapPence).toBe(500);
  });
  test('terms fallback says the plain words', () => {
    const t = parseCreditsInfo({ ...live, terms: undefined }).terms;
    expect(t).toBe(CREDITS_TERMS_FALLBACK);
    expect(t).toContain('non-refundable except where the law requires');
    expect(t).toContain("don't expire");
    expect(t).toContain('Top-ups pay for b. Keep it small.');
    expect(t).not.toContain('$b');
  });
});

describe('amount → sats', () => {
  test('pence to sats at the rate, rounded down', () => {
    // £40/BSV: £1 = 0.025 BSV = 2,500,000 sats.
    expect(penceToSats(100, 40)).toBe(2_500_000);
    expect(penceToSats(10, 40)).toBe(250_000);
    expect(penceToSats(1, 30)).toBe(33_333); // 33,333.33 → down
    expect(penceToSats(0, 40)).toBeNull();
    expect(penceToSats(100, 0)).toBeNull();
    expect(penceToSats(100, Number.NaN)).toBeNull();
  });
  test('round trip never exceeds the amount', () => {
    for (const rate of [17.3, 29.99, 41.07, 123.45]) {
      for (const p of [10, 100, 500, 2000]) expect(satsToPence(penceToSats(p, rate)!, rate)).toBeLessThanOrEqual(p);
    }
  });
  test('credits for pence', () => {
    expect(creditsForPence(100, 1)).toBe(100);
    expect(creditsForPence(99.9999, 1)).toBe(99);
    expect(creditsForPence(0.5, 1)).toBe(0);
  });
  test('pounds box', () => {
    expect(parsePounds('2.50')).toBe(250);
    expect(parsePounds('£3')).toBe(300);
    expect(parsePounds('0')).toBeNull();
    expect(parsePounds('1.234')).toBeNull();
    expect(parsePounds('abc')).toBeNull();
  });
});

describe('top-up plan and cap', () => {
  const info = parseCreditsInfo(live);
  test('£5 at £40/BSV', () => {
    const r = planTopUp(info, 500, 40);
    expect(r.ok && r.plan).toEqual({ pence: 500, sats: 12_500_000, credits: 500 });
  });
  test('cap £20', () => {
    expect(planTopUp(info, 2000, 40).ok).toBe(true);
    const r = planTopUp(info, 2001, 40);
    expect(!r.ok && r.error).toContain('up to £20');
    expect(planTopUp(parseCreditsInfo({ ...live, topupCapPence: 500 }), 600, 40).ok).toBe(false);
  });
  test('minimum and missing rate', () => {
    expect(planTopUp(info, 5, 40).ok).toBe(false);
    expect(planTopUp(info, 100, 0).ok).toBe(false);
    expect(planTopUp(parseCreditsInfo(null), 100, 40).ok).toBe(false);
  });
  test('the sats sent are never worth more than the cap at the quoted rate', () => {
    const r = planTopUp(info, 2000, 37.77);
    expect(r.ok && satsToPence(r.plan.sats, 37.77)).toBeLessThanOrEqual(2000);
  });
});

describe('deposit output', () => {
  test('OP_FALSE OP_RETURN <reference>, as the server checks it', () => {
    const hex = depositScriptHex(REF);
    const refHex = Buffer.from(REF, 'utf8').toString('hex');
    expect(hex.startsWith('006a')).toBe(true);
    expect(hex).toBe(`006a21${refHex}`); // 33-byte push
    expect(hex.includes(refHex)).toBe(true);
  });
  test('requests: sats to the treasury plus the 0-sat reference', () => {
    expect(depositRequests(TREASURY, REF, 12_345)).toEqual([
      { address: TREASURY, satoshis: 12_345 },
      { script: depositScriptHex(REF), satoshis: 0 },
    ]);
  });
  test('refuses a bad address, reference or amount', () => {
    expect(() => depositRequests('3abc', REF, 1)).toThrow();
    expect(() => depositRequests(TREASURY, 'bcredits:zz', 1)).toThrow();
    expect(() => depositRequests(TREASURY, REF, 0)).toThrow();
    expect(() => depositRequests(TREASURY, REF, 1.5)).toThrow();
  });
});

describe('card and history', () => {
  test('formatting', () => {
    expect(fmtCredits(1250)).toBe('1,250 bCredits');
    expect(fmtCredits(1)).toBe('1 bCredit');
    expect(fmtPence(40)).toBe('40p');
    expect(fmtPence(2000)).toBe('£20');
    expect(fmtPence(1250)).toBe('£12.50');
  });
  test('ledger, labels and spent so far', () => {
    const rows = parseLedger({
      entries: [
        { id: 1, kind: 'deposit', units: 500, txid: 'ab', balanceAfter: 500, createdAt: 'x' },
        { id: 2, kind: 'debit', app: 'b', action: 'reply', units: 3, balanceAfter: 497, createdAt: 'y' },
        { id: 3, kind: 'debit', app: 'b', action: 'reply', units: 2, balanceAfter: 495, createdAt: 'z' },
        { kind: 'weird', units: 1 },
      ],
    });
    expect(rows.length).toBe(3);
    expect(entryLabel(rows[0])).toBe('Top up');
    expect(entryLabel(rows[1])).toBe('b reply');
    expect(entryAmount(rows[1])).toBe('−3');
    expect(spentSoFar(rows)).toBe(5);
  });
  test('pending', () => {
    let p = addPending([], 'tx1', 100, 0);
    p = addPending(p, 'tx1', 100, 0);
    expect(p.length).toBe(1);
    expect(removePending(p, 'tx1')).toEqual([]);
    expect(prunePending(p, 8 * 86_400_000)).toEqual([]);
  });
  test('deposit outcome', () => {
    expect(depositOutcome(200, { balance: 10 })).toBe('credited');
    expect(depositOutcome(202, { pending: true })).toBe('pending');
    expect(depositOutcome(200, { pending: true })).toBe('pending');
    expect(depositOutcome(400, {})).toBe('failed');
  });
});

describe('Ask b from bCredits', () => {
  test('only with a balance, when the server answers credit turns', () => {
    const i = parseCreditsInfo({ ...live, agentTurn: true });
    expect(canAskFromCredits(i)).toBe(true);
    expect(canAskFromCredits({ ...i, balance: 0 })).toBe(false);
    expect(canAskFromCredits({ ...i, agentTurn: false })).toBe(false);
  });
  test('reply and low balance', () => {
    expect(parseCreditsReply({ text: ' hi ', credits: { charged: 3, balance: 97 } })).toEqual({
      text: 'hi',
      charged: 3,
      balance: 97,
    });
    expect(lowBalanceOf(402, { balance: 2 })).toBe(2);
    expect(lowBalanceOf(400, { code: 'insufficient_credits' })).toBe(0);
    expect(lowBalanceOf(500, {})).toBeNull();
    expect(lowBalanceText(0)).toContain('Top up');
    expect(lowBalanceText(2)).toContain('2 bCredits');
  });
  test('gecko rate', () => {
    expect(parseGeckoGbp({ 'bitcoin-cash-sv': { gbp: 31.2 } })).toBe(31.2);
    expect(parseGeckoGbp({})).toBeNull();
  });
});
