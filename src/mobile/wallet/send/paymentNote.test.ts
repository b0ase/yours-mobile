import { describe, expect, mock, test } from 'bun:test';
import type { WalletInterface } from '@bsv/sdk';
import { cleanPaymentNote, PAYMENT_NOTE_MAX, sendPaymentNote } from './paymentNote';

const KEY = '030f8d4f47ae853abf8adc939520d360213193709fc846989a436add16d0b946e7';
const resolve = async (to: string) => ({ key: KEY, label: to });

const wallet = {} as WalletInterface;

describe('payment message', () => {
  test('sends the trimmed message as an unstamped bMail to the payee key', async () => {
    const send = mock(async () => ({}) as never);
    const ok = await sendPaymentNote(wallet, 'satoshi@bwalletx.com', '  Thanks for testing!  ', '0.25 BSV', {
      send,
      resolve,
    });
    expect(ok).toBe(true);
    const args = (send.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(args.to).toBe(KEY);
    expect(args.sats).toBe(0);
    expect(args.sealed).toEqual({ subject: 'Payment: 0.25 BSV', body: 'Thanks for testing!' });
  });

  test('nothing is sent for an empty message or a bare address', async () => {
    const send = mock(async () => ({}) as never);
    expect(await sendPaymentNote(wallet, 'satoshi@bwalletx.com', '   ', '1 BSV', { send, resolve })).toBe(false);
    expect(await sendPaymentNote(wallet, '1D4ZKi3gExampleAddressxxxxxxxxxxx', 'hi', '1 BSV', { send, resolve })).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
  });

  test('long messages are capped', () => {
    expect(cleanPaymentNote('x'.repeat(PAYMENT_NOTE_MAX + 50))).toHaveLength(PAYMENT_NOTE_MAX);
  });
});
