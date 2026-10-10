import { describe, expect, test } from 'bun:test';
import { pickGate, type PickGateInput } from './pickGate';
import { parseTyped } from './swapApi';

const base: PickGateInput = {
  amount: 0.5,
  typed: '0.5',
  addressState: 'ok',
  est: { toAmount: 3.2, minAmount: 0.1 },
  estError: '',
  estLoading: false,
  busy: false,
  ticker: 'ltc',
};
const r = (p: Partial<PickGateInput>) => pickGate({ ...base, ...p });

describe('pickGate', () => {
  test('all good', () => expect(r({})).toEqual({ ok: true, reason: null }));
  test('empty amount', () => expect(r({ typed: '', amount: null }).reason).toBe('Enter an amount'));
  test('bad amount', () => expect(r({ typed: 'abc', amount: null }).reason).toMatch(/valid amount/));
  test('address loading', () => expect(r({ addressState: 'loading' }).reason).toMatch(/BSV address/));
  test('address failed offers retry', () => {
    const g = r({ addressState: 'error' });
    expect(g.ok).toBe(false);
    expect(g.ok === false && g.retryAddress).toBe(true);
    expect(g.reason).toBe('Couldn’t get your BSV address — try again');
  });
  test('quote loading', () => expect(r({ est: null, estLoading: true }).reason).toBe('Getting a quote…'));
  test('quote error', () => expect(r({ est: null, estError: 'down' }).reason).toMatch(/Couldn’t get a quote: down/));
  test('below min', () =>
    expect(r({ est: { toAmount: 1, minAmount: 1, belowMin: true } }).reason).toBe('Minimum is 1 LTC'));
  test('below min without flag', () =>
    expect(r({ est: { toAmount: 1, minAmount: 2 } }).reason).toBe('Minimum is 2 LTC'));
  test('null quote', () => expect(r({ est: { toAmount: null, minAmount: 0.1 } }).ok).toBe(false));
  test('busy', () => expect(r({ busy: true }).ok).toBe(false));
});

describe('parseTyped', () => {
  test('comma decimal', () => expect(parseTyped('0,5')).toBe(0.5));
  test('thousands comma', () => expect(parseTyped('1,000.5')).toBe(1000.5));
  test('spaces', () => expect(parseTyped(' 0.5 ')).toBe(0.5));
  test('empty', () => expect(parseTyped('')).toBeNull());
});

describe('stageLabel', () => {
  test('stages', async () => {
    const { stageLabel } = await import('./promo');
    expect(stageLabel('waiting')).toBe('waiting for your deposit');
    expect(stageLabel('sending')).toBe('sending BSV');
  });
});
