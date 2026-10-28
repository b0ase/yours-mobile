import { describe, expect, test } from 'bun:test';
import { classifySendError } from './sendErrors';

const TXID = 'a'.repeat(64);

describe('classifySendError', () => {
  test('toolbox WERR_INTERNAL (the owner 28 Oct failure) is explained, never raw', () => {
    const e = Object.assign(new Error('An internal error has occurred.'), { code: 'WERR_INTERNAL' });
    const r = classifySendError(e);
    expect(r.kind).toBe('wallet-internal');
    expect(r.message).not.toContain('An internal error has occurred');
    expect(r.message).toMatch(/Nothing was broadcast/);
    expect(r.detail).toContain('An internal error has occurred');
    expect(r.detail).toContain('WERR_INTERNAL');
  });
  test('service worker never got the message: nothing sent, try again', () => {
    const r = classifySendError('Could not establish connection. Receiving end does not exist.');
    expect(r).toMatchObject({ kind: 'worker-restarted', moneyMoved: 'no' });
    expect(r.message).toMatch(/Nothing was sent\. Try again/);
  });
  test('worker died mid-send: status unknown, check History', () => {
    const r = classifySendError('The message port closed before a response was received.', 'send');
    expect(r).toMatchObject({ kind: 'worker-restarted', moneyMoved: 'unknown' });
    expect(r.message).toMatch(/Check History/);
  });
  test('worker died before signing: nothing sent', () => {
    expect(classifySendError('The message port closed before a response was received.', 'before-sign').moneyMoved).toBe(
      'no',
    );
  });
  test('another wallet extension', () => {
    expect(classifySendError('OTHER_WALLET_EXTENSION').kind).toBe('other-extension');
  });
  test('insufficient funds keeps the background numbers', () => {
    const m = 'Insufficient funds: this needs 900 sats, and 100 sats are spendable right now.';
    const r = classifySendError(m);
    expect(r.kind).toBe('insufficient-funds');
    expect(r.message).toContain('900 sats');
    expect(r.message).toContain('Nothing was sent');
  });
  test('raw WERR_INSUFFICIENT_FUNDS', () => {
    const r = classifySendError('WERR_INSUFFICIENT_FUNDS: 1234 more satoshis needed');
    expect(r.kind).toBe('insufficient-funds');
    expect(r.message).toContain('1234');
  });
  test('broadcast rejected: coins unchanged, reason shown', () => {
    const r = classifySendError(
      `double spend: a coin or the listing was already spent; broadcaster said: missing inputs. txid ${TXID}`,
    );
    expect(r.kind).toBe('broadcast-failed');
    expect(r.message).toMatch(/^Broadcast failed: missing inputs/);
    expect(r.message).toContain('Your coins are unchanged');
  });
  test('broadcast unknown: check History, carries txid', () => {
    const r = classifySendError(`broadcast service error, try again (${TXID})`);
    expect(r).toMatchObject({ kind: 'broadcast-unknown', moneyMoved: 'unknown', txid: TXID });
    expect(r.message).toContain(TXID);
    expect(r.message).toMatch(/Check History before/);
  });
  test('rate limited / offline', () => {
    expect(classifySendError('Too Many Requests').kind).toBe('network');
    expect(classifySendError(new TypeError('Failed to fetch')).kind).toBe('network');
  });
  test('storage quota', () => {
    expect(classifySendError('QUOTA_BYTES quota exceeded').kind).toBe('storage-full');
  });
  test('locked and cancelled', () => {
    expect(classifySendError('Wallet is locked').kind).toBe('locked');
    expect(classifySendError('Permission denied by user').kind).toBe('cancelled');
  });
  test('anything else: never raw, says check History, keeps detail', () => {
    const r = classifySendError('zzz weird');
    expect(r.kind).toBe('unknown');
    expect(r.message).not.toContain('zzz');
    expect(r.detail).toContain('zzz weird');
  });
});
