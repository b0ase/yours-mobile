import { describe, expect, test } from 'bun:test';
import { bsvToSats, parseScan } from './parseScan';

const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

describe('parseScan', () => {
  test('BIP21 with amount, label and message', () => {
    expect(parseScan(`bitcoin:${ADDR}?amount=0.0015&label=Coffee%20shop&message=Latte+x2`)).toEqual({
      kind: 'pay',
      to: ADDR,
      amountSats: 150_000,
      label: 'Coffee shop',
      message: 'Latte x2',
    });
  });

  test('BIP21 without query, bsv: scheme, bad amount ignored', () => {
    expect(parseScan(`BITCOIN:${ADDR}`)).toEqual({ kind: 'pay', to: ADDR });
    expect(parseScan(`bsv:${ADDR}?amount=-1`)).toEqual({ kind: 'pay', to: ADDR });
    expect(parseScan(`bitcoin:${ADDR}?amount=1e3`)).toEqual({ kind: 'pay', to: ADDR });
  });

  test('BIP21 with a bad address is just text', () => {
    expect(parseScan('bitcoin:notanaddress?amount=1').kind).toBe('text');
  });

  test('plain address, paymail, $handle', () => {
    expect(parseScan(ADDR)).toEqual({ kind: 'pay', to: ADDR });
    expect(parseScan(' alice@bwallet.space ')).toEqual({ kind: 'pay', to: 'alice@bwallet.space' });
    expect(parseScan('$alice')).toEqual({ kind: 'pay', to: '$alice' });
  });

  test('person page links', () => {
    expect(parseScan('https://bwalletx.com/$Alice')).toEqual({ kind: 'person', handle: 'alice', to: '$alice' });
    expect(parseScan('https://www.bwalletx.com/u/bob/')).toEqual({ kind: 'person', handle: 'bob', to: '$bob' });
    expect(parseScan('https://bwalletx.com/%24carol')).toEqual({ kind: 'person', handle: 'carol', to: '$carol' });
    expect(parseScan('https://bwalletx.com/download').kind).toBe('text');
    expect(parseScan('https://evil.example/$alice').kind).toBe('text');
  });

  test('pairing codes go to pairing', () => {
    const link = 'https://www.bwallet.space/pair?v=1&r=relay.example&c=x&k=y&o=https://a.b&e=1';
    expect(parseScan(link)).toEqual({ kind: 'pair', text: link });
  });

  test('junk is text', () => {
    expect(parseScan('hello world')).toEqual({ kind: 'text', text: 'hello world' });
    expect(parseScan('')).toEqual({ kind: 'text', text: '' });
    expect(parseScan('WIFI:S:home;T:WPA;P:secret;;').kind).toBe('text');
    expect(parseScan('javascript:alert(1)').kind).toBe('text');
  });

  test('bsvToSats is exact', () => {
    expect(bsvToSats('0.1')).toBe(10_000_000);
    expect(bsvToSats('1.00000001')).toBe(100_000_001);
    expect(bsvToSats('.5')).toBe(50_000_000);
    expect(bsvToSats('0')).toBeNull();
    expect(bsvToSats('0.000000001')).toBeNull();
    expect(bsvToSats('abc')).toBeNull();
  });
});
