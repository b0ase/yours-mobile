import { describe, expect, test } from 'bun:test';
import {
  MAX_MESSAGE_SATS,
  bitsignPaidBackend,
  formatPrice,
  parsePrice,
  parseQuote,
  payDecision,
  turnBody,
} from './paid';
import { addSpend, dayOf, parseAgentPrefs, spentToday } from './agentPrefs';

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

describe('pricing', () => {
  test('formatPrice is USD first, sats only without a rate', () => {
    expect(formatPrice(1000, 40)).toBe('$0.0004');
    expect(formatPrice(100_000, 40)).toBe('$0.04');
    expect(formatPrice(500, 0)).toBe('500 sats');
    expect(formatPrice(33_334, 30, 0.01)).toBe('$0.01');
    expect(formatPrice(500, 0, 0.01)).toBe('$0.01');
  });

  test('parsePrice: reads usd when present', () => {
    expect(parsePrice({ enabled: true, usd: 0.01, sats: 2000, bsvUsd: 50 }).usd).toBe(0.01);
    expect(parsePrice({ enabled: true, sats: 2000, bsvUsd: 50 }).usd).toBeNull();
    expect(parsePrice({ enabled: true, usd: -1, sats: 2000 }).usd).toBeNull();
  });
  test('parsePrice: disabled unless a sane positive price', () => {
    expect(parsePrice({ enabled: true, sats: 2000, bsvUsd: 40, model: 'm' }).enabled).toBe(true);
    expect(parsePrice({ enabled: true, sats: 0 }).enabled).toBe(false);
    expect(parsePrice({ enabled: true, sats: MAX_MESSAGE_SATS + 1 }).enabled).toBe(false);
    expect(parsePrice(null).reason).toBeTruthy();
  });

  test('parseQuote validates id, amount, address and expiry', () => {
    const now = 1_000;
    const ok = { quoteId: 'q-12345678', sats: 1500, payTo: ADDR, expiresAt: now + 60_000 };
    expect(parseQuote(ok, now)).toEqual(ok);
    expect(() => parseQuote({ ...ok, payTo: 'bc1qxyz' }, now)).toThrow();
    expect(() => parseQuote({ ...ok, sats: -1 }, now)).toThrow();
    expect(() => parseQuote({ ...ok, expiresAt: now - 1 }, now)).toThrow();
    expect(() => parseQuote({ ...ok, quoteId: '../x' }, now)).toThrow();
  });
});

describe('payDecision', () => {
  test('daily limit is absolute; one-click decides auto vs confirm', () => {
    let asked = 0;
    const yes = () => (asked++, true);
    expect(payDecision(1000, 0, 0, yes)).toEqual({ kind: 'refuse', reason: 'limit-off' });
    expect(payDecision(1000, 10_000, 9_500, yes)).toEqual({ kind: 'refuse', reason: 'over-daily' });
    expect(asked).toBe(0); // a refused message never uses a one-click slot
    expect(payDecision(1000, 10_000, 0, yes)).toEqual({ kind: 'auto' });
    expect(payDecision(1000, 10_000, 0, () => false)).toEqual({ kind: 'confirm' });
    expect(payDecision(MAX_MESSAGE_SATS + 1, 1e9, 0, yes).kind).toBe('refuse');
  });

  test('spend ledger resets each day', () => {
    const t = new Date(2026, 9, 2, 12).getTime();
    const l = addSpend(addSpend(null, 500, t), 700, t);
    expect(spentToday(l, t)).toBe(1200);
    expect(spentToday(l, t + 86_400_000)).toBe(0);
    expect(l.day).toBe(dayOf(t));
  });
});

describe('paid backend', () => {
  test('never sends a provider key; only quote, txid, transcript and guide', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const be = bitsignPaidBackend(async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith('/quote'))
        return { quoteId: 'q-12345678', sats: 1000, payTo: ADDR, expiresAt: Date.now() + 1e5 };
      if (path.endsWith('/turn')) return { text: ' hi ' };
      return { enabled: true, sats: 1000 };
    });
    const q = await be.quote([{ role: 'user', text: 'hey' }]);
    expect(await be.turn(q, 'tx', [{ role: 'user', text: 'hey' }], 'GUIDE')).toBe('hi');
    expect(calls.map((c) => c.path)).toEqual(['/api/bitsign/agent/quote', '/api/bitsign/agent/turn']);
    expect(Object.keys(turnBody(q, 'tx', [], 'g')).sort()).toEqual(['client', 'messages', 'quoteId', 'system', 'txid']);
    expect(turnBody(q, 'tx', [], 'g').client).toEqual({ platform: 'web' });
    expect(turnBody(q, 'tx', [], 'g', '0100beef').beef).toBe('0100beef');
    expect(Object.keys(turnBody(q, 'tx', [], 'g', 'not hex!'))).not.toContain('beef');
    await be.turn(q, 'tx', [{ role: 'user', text: 'hey' }], 'GUIDE', 'ABCDEF');
    expect((calls[2].body as { beef?: string }).beef).toBe('ABCDEF');
    expect(JSON.stringify(calls)).not.toMatch(/sk-|api[_-]?key/i);
  });
});

describe('agent prefs', () => {
  test('bad stored values fall back to defaults', () => {
    const p = parseAgentPrefs({ mode: 'free', provider: 'x', dailyLimitCents: 7, models: { openai: 'bad model!' } });
    expect(p.mode).toBe('paid');
    expect(p.provider).toBe('anthropic');
    expect(p.dailyLimitCents).toBe(100);
    expect(p.models.openai).toBe('gpt-5-mini');
  });
});
