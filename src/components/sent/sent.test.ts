import { describe, expect, test } from 'bun:test';
import {
  celebrateSend,
  formatRecipients,
  formatSentAmount,
  getSent,
  sentFromResult,
  setSent,
  shortRecipient,
  txUrl,
} from './sent';
import { DEFAULT_PREFS, parsePrefs } from '../../mobile/settings/prefs';

const TXID = 'a'.repeat(64);
const details = { amount: { kind: 'bsv' as const, sats: 10_000 }, recipients: ['bob@handcash.io'] };

describe('sentFromResult: only confirmed broadcasts trigger the Sent! screen', () => {
  test('txid and no error → shows', () => {
    expect(sentFromResult({ txid: TXID }, details)?.txid).toBe(TXID);
    expect(sentFromResult(TXID.toUpperCase(), details)?.txid).toBe(TXID);
  });
  test('error, missing or malformed txid → nothing', () => {
    expect(sentFromResult({ txid: TXID, error: 'broadcast-failed' }, details)).toBeNull();
    expect(sentFromResult({ error: 'insufficient-funds' }, details)).toBeNull();
    expect(sentFromResult({ txid: '' }, details)).toBeNull();
    expect(sentFromResult({ txid: 'abc' }, details)).toBeNull();
    expect(sentFromResult({ txid: null }, details)).toBeNull();
    expect(sentFromResult(null, details)).toBeNull();
    expect(sentFromResult(undefined, details)).toBeNull();
    expect(sentFromResult('', details)).toBeNull();
  });
  test('celebrateSend sets the store only on success', () => {
    setSent(null);
    expect(celebrateSend({ error: 'x' }, details)).toBe(false);
    expect(getSent()).toBeNull();
    expect(celebrateSend({ txid: TXID }, details)).toBe(true);
    expect(getSent()?.recipients).toEqual(['bob@handcash.io']);
    setSent(null);
  });
});

describe('formatSentAmount', () => {
  test('BSV: dollars first, sats below', () => {
    expect(formatSentAmount({ kind: 'bsv', sats: 100_000 }, 50)).toEqual({
      primary: '$0.05',
      secondary: '100,000 sats',
    });
  });
  test('BSV without a rate: sats first, BSV below', () => {
    expect(formatSentAmount({ kind: 'bsv', sats: 123_456 }, 0)).toEqual({
      primary: '123,456 sats',
      secondary: '0.00123456 BSV',
    });
  });
  test('MNEE, tokens, NFTs', () => {
    expect(formatSentAmount({ kind: 'mnee', amount: 5 })).toEqual({ primary: '$5.00', secondary: '5 MNEE' });
    expect(formatSentAmount({ kind: 'token', display: '1,000', ticker: 'PEPE' }).primary).toBe('1,000 PEPE');
    expect(formatSentAmount({ kind: 'nft', count: 1, name: 'Ninja #7' })).toEqual({
      primary: 'Ninja #7',
      secondary: '1 NFT',
    });
    expect(formatSentAmount({ kind: 'nft', count: 1, name: '' }).primary).toBe('1 NFT');
    expect(formatSentAmount({ kind: 'nft', count: 3 }).primary).toBe('3 NFTs');
  });
});

describe('recipients', () => {
  test('addresses shortened, names kept', () => {
    expect(shortRecipient('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe('1BoatS…tpyT');
    expect(shortRecipient('$alice')).toBe('$alice');
    expect(shortRecipient('alice@handcash.io')).toBe('alice@handcash.io');
    expect(shortRecipient('averyveryverylongpaymailname@example.com')).toBe('averyveryverylon…mple.com');
  });
  test('several recipients collapse; duplicates and blanks ignored', () => {
    expect(formatRecipients([])).toBe('');
    expect(formatRecipients(['bob@x.io', 'bob@x.io', ' '])).toBe('bob@x.io');
    expect(formatRecipients(['bob@x.io', 'amy@x.io', '$carl'])).toBe('bob@x.io +2 more');
  });
  test('WhatsOnChain link', () => {
    expect(txUrl(TXID)).toBe(`https://whatsonchain.com/tx/${TXID}`);
  });
});

describe('Sounds preference', () => {
  test('on by default; off only when explicitly false', () => {
    expect(DEFAULT_PREFS.sounds).toBe(true);
    expect(parsePrefs({}).sounds).toBe(true);
    expect(parsePrefs({ sounds: 'no' }).sounds).toBe(true);
    expect(parsePrefs({ sounds: false }).sounds).toBe(false);
  });
});
