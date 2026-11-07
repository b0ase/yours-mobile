import { describe, expect, test } from 'bun:test';
import {
  classifySendError,
  DOUBLE_SPEND_PENDING_MESSAGE,
  DELIVERY_UNCONFIRMED_MESSAGE,
  DEVICE_NOT_ACTIVE_MESSAGE,
  MISSING_PARENT_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
  REFUSED_NOT_SENT_MESSAGE,
  withoutOwnTxids,
  SPENT_ELSEWHERE_MESSAGE,
  SPENT_ELSEWHERE_SHORT_MESSAGE,
  SPENT_ELSEWHERE_STUCK_MESSAGE,
} from './sendErrors';

const TXID = 'a'.repeat(64);

describe('classifySendError', () => {
  test("P0 5 Nov 2026: refused before the build because this device's store wasn't active: nothing was sent", () => {
    const e = Object.assign(new Error(DEVICE_NOT_ACTIVE_MESSAGE), {
      name: 'WERR_NOT_ACTIVE',
      code: 'WERR_NOT_ACTIVE',
      detail:
        "WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.",
    });
    for (const phase of ['send', 'before-sign'] as const) {
      const r = classifySendError(e, phase);
      expect(r).toMatchObject({ kind: 'device-not-active', moneyMoved: 'no', message: DEVICE_NOT_ACTIVE_MESSAGE });
      expect(r.message).toMatch(/Nothing was sent\. Try again/);
      expect(r.message).not.toMatch(/can't confirm/i);
      expect(r.detail).toContain('conflicting active stores'); // the toolbox's reason stays behind Details
    }
    // As a site or the Store sheet carries it (plain text).
    expect(classifySendError(DEVICE_NOT_ACTIVE_MESSAGE).moneyMoved).toBe('no');
  });
  test('the toolbox\'s bare WERR_NOT_ACTIVE (its step unknown here) stays honest: "can\'t confirm" while sending', () => {
    const raw =
      "WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.";
    expect(classifySendError(raw, 'send')).toMatchObject({ kind: 'unknown', moneyMoved: 'unknown' });
    expect(classifySendError(raw, 'before-sign')).toMatchObject({ moneyMoved: 'no' });
  });
  test('toolbox WERR_INTERNAL (the owner 28 Oct failure) is explained, never raw', () => {
    const e = Object.assign(new Error('An internal error has occurred.'), { code: 'WERR_INTERNAL' });
    const r = classifySendError(e);
    expect(r.kind).toBe('wallet-internal');
    expect(r.message).not.toContain('An internal error has occurred');
    // 17d L4: it is `unknown`, so it never says "Nothing was broadcast".
    expect(r.moneyMoved).toBe('unknown');
    expect(r.message).not.toMatch(/Nothing was (broadcast|sent)/);
    expect(r.message).toMatch(/can't confirm whether it went out/);
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
  test('coins spent from another device (owner, 4 Nov 2026): plain words, nothing sent, never "check History"', () => {
    for (const raw of [
      SPENT_ELSEWHERE_MESSAGE,
      // The wording before 4 Nov, still classified the same.
      'Some coins were already spent on another device. Refreshed your balance — please try again.',
      Object.assign(new Error(SPENT_ELSEWHERE_MESSAGE), { code: 'WERR_SPENT_ELSEWHERE' }),
    ]) {
      const r = classifySendError(raw);
      expect(r).toMatchObject({ kind: 'spent-elsewhere', moneyMoved: 'no', message: SPENT_ELSEWHERE_MESSAGE });
      expect(r.message).not.toMatch(/check History|can't confirm/i);
    }
    const short = classifySendError(SPENT_ELSEWHERE_SHORT_MESSAGE);
    expect(short).toMatchObject({ kind: 'spent-elsewhere', moneyMoved: 'no', message: SPENT_ELSEWHERE_SHORT_MESSAGE });
    // The heal's text wins over the broadcaster's raw words when both are present.
    expect(classifySendError(`${SPENT_ELSEWHERE_MESSAGE} (UTXO_SPENT, REJECTED)`).kind).toBe('spent-elsewhere');
  });
  test('an earlier payment of ours went out (review 17, F1): say so, nothing more sent, the txid for History', () => {
    const r = classifySendError(ownPaymentOutMessage(TXID));
    expect(r).toMatchObject({ kind: 'earlier-payment-out', moneyMoved: 'yes', txid: TXID });
    expect(r.message).toBe(ownPaymentOutMessage(`${TXID.slice(0, 8)}…`));
    expect(r.message).toMatch(/won't pay twice/);
    expect(r.message).not.toMatch(/try again|another device/i);
  });
  test('a double spend that may still go through (review 17 F2, 17b H1): money may move, no "try again" now', () => {
    for (const raw of [
      DOUBLE_SPEND_PENDING_MESSAGE,
      // A BARE double spend (the toolbox text, any path: sites, signAction, the retry's own refusal) is the same.
      `Undelayed createAction or signAction results require review. double spend: a coin or the listing was already spent (competing ${TXID.slice(0, 12)}…)`,
      'DOUBLE_SPEND_ATTEMPTED',
    ]) {
      const r = classifySendError(raw);
      expect(r).toMatchObject({
        kind: 'broadcast-unknown',
        moneyMoved: 'unknown',
        message: DOUBLE_SPEND_PENDING_MESSAGE,
      });
      expect(r.message).not.toMatch(/unchanged|try again/i);
    }
  });
  test('a refusal says "not sent" only when the background checked the chain (17b M1)', () => {
    // Bare refusal text: nothing checked the chain, so it may have gone out.
    for (const raw of [
      `Undelayed createAction or signAction results require review. rejected by the network as invalid; broadcaster said: UTXO_SPENT (70)`,
      'REJECTED',
    ]) {
      const r = classifySendError(raw);
      expect(r).toMatchObject({
        kind: 'broadcast-unknown',
        moneyMoved: 'unknown',
        message: REFUSED_MAYBE_SENT_MESSAGE,
      });
      expect(r.message).not.toMatch(/unchanged/i);
    }
    expect(classifySendError(REFUSED_MAYBE_SENT_MESSAGE).moneyMoved).toBe('unknown');
    // The background's chain-checked sentence.
    expect(classifySendError(REFUSED_NOT_SENT_MESSAGE)).toMatchObject({
      kind: 'broadcast-failed',
      moneyMoved: 'no',
      message: REFUSED_NOT_SENT_MESSAGE,
    });
  });
  test('an earlier payment of ours not proven to this payee (17c M1): neutral, unknown, never "send again"', () => {
    const r = classifySendError(OWN_COIN_OTHER_PAYMENT_MESSAGE);
    expect(r).toMatchObject({
      kind: 'earlier-payment-out',
      moneyMoved: 'unknown',
      message: OWN_COIN_OTHER_PAYMENT_MESSAGE,
    });
    expect(r.message).not.toMatch(/won't pay twice|someone else|then send again/i);
    expect(r.message).toMatch(/don't send again/);
  });
  test('17c H2 (S6): a $name payment broadcast but not confirmed by the payee host is SENT, never "Nothing was sent"', () => {
    for (const raw of [
      'delivery-failed: Failed to fetch',
      'delivery-failed: P2P send failed: 429',
      'delivery-failed: The operation timed out.',
      'delivery-failed: P2P send failed: 503',
    ]) {
      const r = classifySendError(raw);
      expect(r).toMatchObject({ kind: 'sent-unconfirmed', moneyMoved: 'yes', message: DELIVERY_UNCONFIRMED_MESSAGE });
      expect(r.message).not.toMatch(/nothing was sent/i);
    }
  });
  test('17c L3: a coin whose parent never reached the network: set aside, unknown', () => {
    expect(classifySendError(MISSING_PARENT_MESSAGE)).toMatchObject({
      kind: 'broadcast-unknown',
      moneyMoved: 'unknown',
    });
  });
  test('17d L4: our own pre-sign refusals say "Nothing was sent" and mean it (no); never "can\'t confirm"', () => {
    const own = 'Payment refused: outputs do not match the approved payments. Nothing was sent.';
    expect(classifySendError(own)).toMatchObject({ kind: 'payment-refused', moneyMoved: 'no', message: own });
    const all = classifySendError('sendAllBsv does not support paymail — use sendBsv with a fixed amount');
    expect(all).toMatchObject({ kind: 'payment-refused', moneyMoved: 'no' });
    expect(all.message).toMatch(/Nothing was sent/);
    // Before: both fell to the generic "can't confirm whether it went out" (unknown).
    for (const r of [classifySendError(own), all]) expect(r.message).not.toMatch(/can't confirm/i);
  });
  test('a site never gets the txid of another payment of this wallet (17b L1)', () => {
    const t = withoutOwnTxids(ownPaymentOutMessage(TXID));
    expect(t).not.toContain(TXID.slice(0, 8));
    expect(t).toBe(ownPaymentOutMessage());
  });
  test('coins that could not be marked (review 17, F6): a real error with what to do', () => {
    expect(classifySendError(SPENT_ELSEWHERE_STUCK_MESSAGE)).toMatchObject({
      kind: 'spent-elsewhere',
      moneyMoved: 'no',
      message: SPENT_ELSEWHERE_STUCK_MESSAGE,
    });
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
  test('broadcast refused as a double spend: may still go through, the reason kept in Details (17b H1)', () => {
    const r = classifySendError(
      `double spend: a coin or the listing was already spent; broadcaster said: missing inputs. txid ${TXID}`,
    );
    expect(r).toMatchObject({ kind: 'broadcast-unknown', moneyMoved: 'unknown', txid: TXID });
    expect(r.detail).toContain('missing inputs');
    expect(r.message).not.toContain('Your coins are unchanged');
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
