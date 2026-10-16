import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { handlePaymentOutputs, parsePaymentRequired } from './extraNames';
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
