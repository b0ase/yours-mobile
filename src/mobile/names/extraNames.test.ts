import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { checkNamePayment, directFee, extraFeeLabel, handlePaymentOutputs, parsePaymentRequired } from './extraNames';
import { commitmentScript } from '../chat/roomSpend';
import { parseHandlesInfo } from '../chat/api';

const to = PrivateKey.fromRandom().toAddress();
const body = {
  code: 'payment_required',
  pay: {
    pence: 1,
    sats: 2500,
    to,
    commitment: { room: 'HANDLES', author: 'alice', body: 'handle:add:two', rule: 'handles-2026-10-15' },
  },
};

describe('extra names (bit-sign 402 flow)', () => {
  test('parses payment_required', () => {
    expect(parsePaymentRequired(body)?.sats).toBe(2500);
    expect(parsePaymentRequired({ code: 'taken' })).toBeNull();
    expect(parsePaymentRequired({ ...body, pay: { ...body.pay, sats: 0 } })).toBeNull();
  });
  test('pays the fee address and carries the room_pay commitment', () => {
    const pay = parsePaymentRequired(body)!;
    const [fee, rec] = handlePaymentOutputs(pay);
    expect(fee.satoshis).toBe(2500);
    expect(rec.satoshis).toBe(0);
    expect(rec.lockingScript).toBe(commitmentScript(pay.commitment).toHex());
  });
  test('parses /me/handles', () => {
    const h = parseHandlesInfo({
      handles: [{ handle: '$One', primary: true }, { handle: 'two' }],
      max: 5,
      next_fee: { pence: 1, sats: 2500, to },
    });
    expect(h.handles).toEqual([
      { handle: 'one', primary: true },
      { handle: 'two', primary: false },
    ]);
    expect(h.nextFee?.sats).toBe(2500);
    expect(parseHandlesInfo({ handles: [], next_fee: null }).nextFee).toBeNull();
  });
});

describe('b-Aware 25 Oct: the name fee paid is the one the user confirmed', () => {
  const pay = parsePaymentRequired(body)!;
  test('same amount and address as confirmed: allowed', () => {
    expect(() => checkNamePayment(pay, { sats: 2500, to })).not.toThrow();
  });
  test('no fee confirmed, a different address, or a higher amount: nothing is paid', () => {
    expect(() => checkNamePayment(pay, null)).toThrow(/Nothing was paid/);
    const other = PrivateKey.fromRandom().toAddress();
    expect(() => checkNamePayment(pay, { sats: 2500, to: other })).toThrow(/Nothing was paid/);
    expect(() => checkNamePayment({ ...pay, sats: 2501 }, { sats: 2500, to })).toThrow(/Nothing was paid/);
    expect(() => checkNamePayment({ ...pay, sats: 1_000_000 }, { sats: 1_000_000, to })).toThrow(/Nothing was paid/);
  });
});

describe('owner pricing 27 Oct: an extra name is $1 in BSV at the live rate', () => {
  test('quotes $1 at the rate and labels it "$1 (≈ N sats)"', () => {
    const q = directFee({ address: to, usd: 1 }, 50)!;
    expect(q).toEqual({ pence: 0, sats: 2_000_000, to, usd: 1, direct: true });
    expect(extraFeeLabel(q)).toBe('$1 (≈ 2,000,000 sats)');
  });
  test('no quote without a rate, without a fee, or above the $5 ceiling', () => {
    expect(directFee({ address: to, usd: 1 }, 0)).toBeNull();
    expect(directFee(null, 50)).toBeNull();
    expect(directFee({ address: to, usd: 50 }, 50)).toBeNull();
  });
  test('bit-sign fees keep their label', () => {
    expect(extraFeeLabel({ pence: 1, sats: 2500, to })).toBe('1p');
    expect(extraFeeLabel(null)).toBe('');
  });
});
