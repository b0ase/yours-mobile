import { describe, expect, test } from 'bun:test';
import { AMOUNT_HINT, isMainnetAddress, looksLikeAmount } from './address';
import { parseRecipient } from './names';
import { sendButton, type SendRow } from '../wallet/send/sendLogic';

const OWNER = '16ueWf1te3FYrXWe5ywgPC1yfctXEsDGAe'; // paid 13 Oct 2026, flagged invalid by mistake
const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'; // 34 chars
const SHORT = '1111111111111111111114oLvT2'; // hash160 of zeros, 27 chars
const ADDR33 = '112QkWJQnB4cTtvBL41ymizSgTquFVMHt'; // 33 chars (hash160 with two leading zero bytes)

describe('isMainnetAddress (base58check, version 0x00)', () => {
  test('accepts real mainnet P2PKH addresses', () => {
    for (const a of [OWNER, GENESIS, SHORT, ADDR33]) expect(isMainnetAddress(a)).toBe(true);
    expect(ADDR33.length).toBe(33);
    expect(GENESIS.length).toBe(34);
  });
  test('accepts with whitespace / zero-width characters from a paste', () => {
    expect(isMainnetAddress(` ${OWNER}\u200B\n`)).toBe(true);
  });
  test('rejects a bad checksum, testnet, P2SH and junk', () => {
    expect(isMainnetAddress(OWNER.slice(0, -1) + 'f')).toBe(false);
    expect(isMainnetAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false); // testnet
    expect(isMainnetAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(false); // P2SH
    expect(isMainnetAddress('$0.01')).toBe(false);
    expect(isMainnetAddress('')).toBe(false);
  });
});

describe('amounts are never recipients', () => {
  test.each(['$0.01', '0.01', '$5', '£1', '1.5', '€10', '1,000', '.5'])('%s', (s) => {
    expect(looksLikeAmount(s)).toBe(true);
    expect(parseRecipient(s)).toEqual({ kind: 'invalid', reason: AMOUNT_HINT });
  });
  test('handles, paymails and addresses still parse', () => {
    expect(parseRecipient('$b0asex').kind).toBe('handle');
    expect(parseRecipient('alice@example.com')).toEqual({ kind: 'paymail', paymail: 'alice@example.com' });
    expect(parseRecipient('$alice@example.com').kind).toBe('paymail');
    expect(parseRecipient(OWNER)).toEqual({ kind: 'address', address: OWNER });
    expect(parseRecipient(ADDR33).kind).toBe('address');
    expect(looksLikeAmount('$b0asex')).toBe(false);
  });
});

describe('Send button agrees with the error message', () => {
  const row = (o: Partial<SendRow> = {}): SendRow => ({
    id: 'a',
    address: OWNER,
    satSendAmount: 543_774,
    usdSendAmount: null,
    amountType: 'bsv',
    ...o,
  });
  const btn = (r: SendRow, st: 'error' | 'ready' | 'typing') =>
    sendButton({ rows: [r], status: { a: st }, names: {}, rate: 20, balanceBsv: 1, sendAll: false });

  test('valid address + amount is sendable', () => {
    expect(btn(row(), 'ready').disabled).toBe(false);
  });
  test('disabled whenever a row error shows, whatever the status', () => {
    for (const st of ['ready', 'typing', 'error'] as const) {
      expect(btn(row({ error: 'Provide a valid BSV or Paymail address.' }), st).disabled).toBe(true);
    }
  });
  test('disabled while the recipient box is in error (e.g. "$0.01")', () => {
    expect(btn(row({ address: '' }), 'error').disabled).toBe(true);
  });
});
