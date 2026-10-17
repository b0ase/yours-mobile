import { describe, expect, test } from 'bun:test';
import { describeWalletError } from '../brand/walletError';
import { noteRefusals, refusalFor, rememberRefusals } from './broadcastRefusals';

const T = (c: string) => c.repeat(64);

describe('broadcast refusals', () => {
  test('records a definite refusal, not a service hiccup', () => {
    noteRefusals([
      { status: 'error', error: new Error('ARC 461: script failed'), txidResults: [{ txid: T('a'), status: 'error' }] },
      { status: 'error', error: new Error('timeout'), txidResults: [{ txid: T('b'), status: 'error', serviceError: true }] },
    ]);
    expect(refusalFor(T('a'))).toBe('ARC 461: script failed');
    expect(refusalFor(T('b'))).toBeUndefined();
  });

  test('wraps postBeef and passes results through', async () => {
    const results = [{ status: 'error', error: new Error('fee too low'), txidResults: [{ txid: T('c'), status: 'error' }] }];
    const s = { postBeef: async () => results };
    expect(rememberRefusals(s)).toBe(true);
    expect(await s.postBeef({}, [T('c')])).toBe(results);
    expect(refusalFor(T('c'))).toBe('fee too low');
  });

  test('the reason and txid reach the message', () => {
    noteRefusals([{ status: 'error', error: new Error('mandatory-script-verify-flag-failed'), txidResults: [{ txid: T('d'), status: 'error' }] }]);
    const e = Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      reviewActionResults: [{ txid: T('d'), status: 'invalidTx' }],
    });
    const m = describeWalletError(e);
    expect(m).toContain('rejected by the network as invalid');
    expect(m).toContain('broadcaster said: mandatory-script-verify-flag-failed');
    expect(m).toContain(`tx ${T('d').slice(0, 12)}…`);
  });
});
