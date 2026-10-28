import { describe, expect, test } from 'bun:test';
import { POPULAR_COINS } from './swapApi';
import {
  bsvexUrl,
  clampAmount,
  extensionSwapPrefill,
  handoffFor,
  matchCoin,
  parseSwapLink,
  parseThen,
  prefillFromQuery,
  SWAP_AMOUNT_MAX,
  swapRoute,
} from './swapLink';
import { toRouter } from '../url/publicUrl';
import { BSVEX_HANDOFF_ON } from '../storeBuild';

const OP = `${'ab'.repeat(32)}_0`;
const Q = 'from=usdt&network=trx&amount=25&then=bsvex:%24FOO';

describe('swap links: parsing', () => {
  test('universal link, app scheme, web path and extension hash all give the same prefill', () => {
    const want = { from: 'usdt', network: 'trx', amount: 25, then: 'bsvex:FOO' };
    expect(parseSwapLink(`https://www.bwallet.space/swap?${Q}`)).toEqual(want);
    expect(parseSwapLink(`https://bwallet.space/swap?${Q}`)).toEqual(want);
    expect(parseSwapLink(`bwalletx://swap?${Q}`)).toEqual(want);
    expect(extensionSwapPrefill('/index.html', `#/swap?${Q}`)).toEqual(want);
    expect(toRouter('/swap', `?${Q}`)).toBe(`/m/exchange/swap?${Q}`);
    expect(toRouter('/exchange/swap', `?${Q}`)).toBe(`/m/exchange/swap?${Q}`);
  });
  test('unknown params are ignored; the route carries only the four known ones, encoded', () => {
    const p = prefillFromQuery('from=BTC&network=btc&amount=0.01&evil=<x>&auto=1');
    expect(p).toEqual({ from: 'btc', network: 'btc', amount: 0.01, then: null });
    expect(swapRoute({ ...p!, then: `bsvex:${OP}` })).toBe(
      `/m/exchange/swap?from=btc&network=btc&amount=0.01&then=bsvex%3A${OP}`,
    );
  });
  test('network defaults to the ticker; from/network must be plain codes', () => {
    expect(prefillFromQuery('from=eth')?.network).toBe('eth');
    for (const q of ['', 'network=btc', 'from=b%20tc', 'from=btc&network=../x', `from=${'a'.repeat(21)}`])
      expect(prefillFromQuery(q)).toBeNull();
  });
  test('validated against the coin list', () => {
    expect(matchCoin({ from: 'usdt', network: 'trx' }, POPULAR_COINS)?.label).toBe('USDT · Tron');
    expect(matchCoin({ from: 'usdt', network: 'sol' }, POPULAR_COINS)).toBeNull();
    expect(matchCoin({ from: 'zzz', network: 'zzz' }, POPULAR_COINS)).toBeNull();
  });
  test('amount is clamped', () => {
    expect(clampAmount('0.123456789')).toBe(0.12345679);
    expect(clampAmount('1e12')).toBe(SWAP_AMOUNT_MAX);
    for (const a of ['0', '-1', 'abc', 'Infinity', 'NaN', '', null, '0.000000001']) expect(clampAmount(a)).toBeNull();
  });
  test('ATTACK: other hosts, paths and schemes are not swap links', () => {
    for (const l of [
      `https://evil.example/swap?${Q}`,
      `http://www.bwallet.space/swap?${Q}`,
      `https://www.bwallet.space/swapx?${Q}`,
      `bwalletx://browse?${Q}`,
      `javascript:alert(1)//swap?${Q}`,
      'nope',
      null,
    ])
      expect(parseSwapLink(l)).toBeNull();
    expect(extensionSwapPrefill('/swap', `#/swap?${Q}`)).toBeNull();
    expect(extensionSwapPrefill('/index.html', `#/send?${Q}`)).toBeNull();
  });
});

describe('swap links: then=bsvex:', () => {
  test('tickers (with or without $) and BSV-21 outpoints', () => {
    expect(parseThen('bsvex:$foo')).toBe('bsvex:FOO');
    expect(parseThen('bsvex:TERRORNODE')).toBe('bsvex:TERRORNODE');
    expect(parseThen(`bsvex:${OP}`)).toBe(`bsvex:${OP}`);
    expect(parseThen(`bsvex:${'ab'.repeat(32)}_12`)).toBe(`bsvex:${'ab'.repeat(32)}_12`);
  });
  test('ATTACK: bad schemes, tickers and outpoints are dropped', () => {
    for (const t of [
      'https://evil.example/',
      'javascript:alert(1)',
      'BSVEX:FOO',
      'bsvexx:FOO',
      'bsvex:',
      'bsvex:$',
      'bsvex:FOO/../../x',
      'bsvex:FO O',
      'bsvex:$$FOO',
      `bsvex:${'A'.repeat(21)}`,
      `bsvex:${'AB'.repeat(32)}_0`,
      `bsvex:${'ab'.repeat(31)}_0`,
      `bsvex:${'ab'.repeat(32)}_`,
      `bsvex:${'ab'.repeat(32)}_-1`,
    ])
      expect(parseThen(t)).toBeNull();
    expect(prefillFromQuery('from=btc&then=https%3A%2F%2Fevil.example')?.then).toBeNull();
  });
  test('bsvex URL from the sats actually received, everything encoded', () => {
    expect(bsvexUrl('bsvex:FOO', 0.12345678, 'abc123')).toBe(
      'https://www.bsvex.com/t/FOO/buy?bsv=12345678&src=bwallet-swap&ref=abc123',
    );
    expect(bsvexUrl(`bsvex:${OP}`, 1, 'a&b=c')).toBe(
      `https://www.bsvex.com/t/${OP}/buy?bsv=100000000&src=bwallet-swap&ref=a%26b%3Dc`,
    );
    expect(bsvexUrl('bsvex:FOO', null, 'x')).toContain('bsv=0&');
    expect(bsvexUrl('javascript:alert(1)', 1, 'x')).toBeNull();
  });
});

describe('swap links: the bsvex hop', () => {
  const swap = { id: 's1', stage: 'done', toAmount: 0.5, then: 'bsvex:FOO' };
  test('flag is off in this release', () => expect(BSVEX_HANDOFF_ON).toBe(false));
  test('flag off: the then is kept on the record, but nothing is shown', () => {
    expect(handoffFor(swap, false)).toBeNull();
    expect(handoffFor(swap, BSVEX_HANDOFF_ON)).toBeNull();
  });
  test('flag on: only once the swap is done', () => {
    expect(handoffFor(swap, true)).toEqual({
      label: 'Continue to bsvex to buy $FOO',
      url: 'https://www.bsvex.com/t/FOO/buy?bsv=50000000&src=bwallet-swap&ref=s1',
    });
    for (const stage of ['waiting', 'sending', 'failed', 'refunded'])
      expect(handoffFor({ ...swap, stage }, true)).toBeNull();
    expect(handoffFor({ ...swap, then: null }, true)).toBeNull();
    expect(handoffFor({ ...swap, then: 'https://evil.example' }, true)).toBeNull();
  });
});
