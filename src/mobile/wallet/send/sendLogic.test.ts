import { describe, expect, test } from 'bun:test';
import {
  addRecents,
  balanceLine,
  loadRecents,
  notePending,
  parseAmount,
  pastedRecipient,
  rememberSent,
  rowSats,
  sendButton,
  type SendRow,
} from './sendLogic';

const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const RATE = 20; // $20 per BSV
const row = (o: Partial<SendRow> = {}): SendRow => ({
  id: 'a',
  address: '',
  satSendAmount: null,
  usdSendAmount: null,
  amountType: 'usd',
  ...o,
});
const btn = (rows: SendRow[], extra: Partial<Parameters<typeof sendButton>[0]> = {}) =>
  sendButton({ rows, status: {}, names: {}, rate: RATE, balanceBsv: 1, sendAll: false, ...extra });

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('amounts', () => {
  test('USD rows convert to sats, rounded up', () => {
    expect(rowSats(row({ usdSendAmount: 5 }), RATE)).toBe(25_000_000);
    expect(rowSats(row({ usdSendAmount: 0.01 }), 3)).toBe(Math.ceil((0.01 / 3) * 1e8));
    expect(rowSats(row({ usdSendAmount: 5 }), 0)).toBe(0);
    expect(rowSats(row({ amountType: 'bsv', satSendAmount: 1234 }), RATE)).toBe(1234);
  });
  test('parseAmount', () => {
    expect(parseAmount('5')).toBe(5);
    expect(parseAmount('$1,000.25')).toBe(1000.25);
    expect(parseAmount('.5')).toBe(0.5);
    expect(parseAmount('5.')).toBe(5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('.')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-3')).toBeNull();
  });
  test('balance line: dollars first, BSV small', () => {
    expect(balanceLine(0.14809429, 18.7)).toBe('$2.77 · 0.14809429 BSV');
    expect(balanceLine(0.148, 0)).toBe('0.148 BSV');
  });
});

describe('send button', () => {
  test('explains what is missing', () => {
    expect(btn([row()])).toEqual({ label: 'Choose who to pay', disabled: true });
    expect(btn([row({ address: ADDR })])).toEqual({ label: 'Enter an amount', disabled: true });
    expect(btn([row({ address: ADDR })], { status: { a: 'loading' } }).label).toBe('Looking up recipient…');
    expect(btn([row({ address: '' })], { status: { a: 'error' } }).label).toBe('Check the recipient');
    expect(btn([row({ address: ADDR, usdSendAmount: 50 })])).toEqual({ label: 'Not enough balance', disabled: true });
    expect(btn([row({ address: ADDR }), row({ id: 'b' })]).label).toBe('Enter an amount for recipient 1');
  });
  test('says exactly what happens', () => {
    expect(btn([row({ address: 'alice@handcash.io', usdSendAmount: 5 })], { names: { a: '$alice' } })).toEqual({
      label: 'Send $5.00 to $alice',
      disabled: false,
    });
    expect(btn([row({ address: ADDR, usdSendAmount: 5 })]).label).toBe('Send $5.00 to 1A1zP1…vfNa');
    expect(
      btn([row({ address: ADDR, usdSendAmount: 1 }), row({ id: 'b', address: ADDR, usdSendAmount: 2 })]).label,
    ).toBe('Send $3.00 to 2 people');
    expect(btn([row({ address: ADDR, amountType: 'bsv', satSendAmount: 1000 })], { rate: 0 }).label).toBe(
      'Send 0.00001 BSV to 1A1zP1…vfNa',
    );
    expect(btn([row({ address: ADDR, usdSendAmount: 5 })], { processing: true }).disabled).toBe(true);
  });
});

describe('paste', () => {
  test('accepts addresses, handles, paymails, names and bitcoin: URIs', () => {
    expect(pastedRecipient(` ${ADDR}\n`)).toBe(ADDR);
    expect(pastedRecipient('$alice')).toBe('$alice');
    expect(pastedRecipient('bob@handcash.io')).toBe('bob@handcash.io');
    expect(pastedRecipient(`bitcoin:${ADDR}?amount=1`)).toBe(ADDR);
  });
  test('rejects anything else', () => {
    expect(pastedRecipient('')).toBeNull();
    expect(pastedRecipient(null)).toBeNull();
    expect(pastedRecipient('hello world')).toBeNull();
    expect(pastedRecipient('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBeNull();
    expect(pastedRecipient('x'.repeat(200))).toBeNull();
  });
});

describe('recents', () => {
  test('newest first, de-duplicated, capped', () => {
    const list = addRecents(
      [{ input: '$a', label: '$a', at: 1 }],
      [
        { input: '$B', label: '$B', at: 2 },
        { input: '$A', label: '$A', at: 2 },
      ],
    );
    expect(list.map((r) => r.input)).toEqual(['$B', '$A']);
    const many = addRecents(
      [],
      Array.from({ length: 20 }, (_, i) => ({ input: `$${i}`, label: '', at: i })),
    );
    expect(many.length).toBe(8);
  });
  test('remembers a send under its friendly name', () => {
    const s = mem();
    notePending('alice@handcash.io', { input: '$alice', label: '$alice', avatar: 'https://x/a.png' });
    rememberSent('acct', ['alice@handcash.io', ADDR], 5, s);
    const got = loadRecents('acct', s);
    expect(got.map((r) => r.input)).toEqual(['$alice', ADDR]);
    expect(got[0].avatar).toBe('https://x/a.png');
    expect(loadRecents('other', s)).toEqual([]);
  });
  test('bad storage never throws', () => {
    expect(loadRecents('acct', { getItem: () => '{oops', setItem: () => undefined })).toEqual([]);
    expect(() =>
      rememberSent('acct', [ADDR], 1, {
        getItem: () => null,
        setItem: () => {
          throw new Error('full');
        },
      }),
    ).not.toThrow();
  });
});
