import { describe, expect, test } from 'bun:test';
import {
  createSiteGate,
  gateFor,
  GATE_REASON,
  SITE_CALL_TIMEOUT_CODE,
  VERIFICATION_TIMEOUT_CODE,
  withSiteCeiling,
  type AuthResult,
} from './siteGate';
import { USER_DENIED_CODE } from '../services/userDenied';

const SITE = 'https://www.bchatx.com';

/** Manual timers: tests fire them explicitly. */
const timers = () => {
  const list: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    list,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, live: true };
      list.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as { live: boolean }).live = false;
    },
    fireAll: () => list.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn())),
  };
};

const gateWith = (auth: (reason: string, host: string) => Promise<AuthResult>, opts: { enabled?: boolean } = {}) => {
  let clock = 1_800_000_000_000;
  const t = timers();
  const calls: string[] = [];
  const gate = createSiteGate({
    enabled: () => opts.enabled ?? true,
    auth: (reason, host) => {
      calls.push(`${reason}|${host}`);
      return auth(reason, host);
    },
    now: () => clock,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  });
  return { gate, calls, t, advance: (ms: number) => (clock += ms) };
};

describe('gateFor', () => {
  test('sign and pay calls only', () => {
    expect(gateFor('createSignature')).toEqual({ kind: 'sign', call: 'createSignature' });
    expect(gateFor('createAction')).toEqual({ kind: 'pay', call: 'createAction' });
    expect(gateFor('signAction')).toEqual({ kind: 'pay', call: 'createAction' });
    expect(gateFor('getPublicKey')).toBeNull();
    expect(gateFor('waitForAuthentication')).toBeNull();
  });
});

describe('site gate', () => {
  test('approve: one prompt with the plain reason, recorded as biometric', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'ok', method: 'biometric' }));
    expect(await gate.check(SITE, 'createSignature')).toBe('biometric');
    expect(calls).toEqual([`${GATE_REASON.sign}|www.bchatx.com`]);
    const last = gate.lastVerification(SITE);
    expect(last?.verifiedBy).toBe('biometric');
    expect(last?.call).toBe('createSignature');
    expect(last?.at).toBe(new Date(1_800_000_000_000).toISOString());
    expect(gate.lastVerification('https://other.example')).toBeNull();
  });

  test('ungated calls never prompt', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'ok', method: 'biometric' }));
    expect(await gate.check(SITE, 'getPublicKey')).toBeNull();
    expect(calls).toEqual([]);
    expect(gate.lastVerification(SITE)).toBeNull();
  });

  test('sign then seal (createSignature + createAction) is one prompt', async () => {
    const { gate, calls, advance } = gateWith(async () => ({ status: 'ok', method: 'passcode' }));
    expect(await gate.check(SITE, 'createSignature')).toBe('passcode');
    advance(5_000);
    expect(await gate.check(SITE, 'createAction')).toBe('passcode');
    expect(calls.length).toBe(1);
    expect(gate.lastVerification(SITE)?.call).toBe('createAction');
    // After the grace window it asks again.
    advance(60_000);
    await gate.check(SITE, 'createSignature');
    expect(calls.length).toBe(2);
  });

  test('every payment after a payment asks again, even inside the grace window', async () => {
    const { gate, calls, advance } = gateWith(async () => ({ status: 'ok', method: 'biometric' }));
    await gate.check(SITE, 'createSignature');
    await gate.check(SITE, 'createAction'); // rides the sign's pass
    advance(1_000);
    await gate.check(SITE, 'signAction'); // a second payment
    advance(1_000);
    await gate.check(SITE, 'createAction'); // and a third
    expect(calls.length).toBe(3);
    expect(calls[1].startsWith(GATE_REASON.pay)).toBe(true);
  });

  test('a payment prompt does not cover a later sign → seal payment', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'ok', method: 'biometric' }));
    await gate.check(SITE, 'createAction');
    await gate.check(SITE, 'createSignature'); // a sign may use the pass
    await gate.check(SITE, 'createAction'); // but the pass already paid once
    expect(calls.length).toBe(2);
  });

  test('concurrent sign + pay share one prompt; concurrent pay + pay ask twice', async () => {
    const answers: ((r: AuthResult) => void)[] = [];
    const { gate, calls } = gateWith(() => new Promise((r) => answers.push(r)));
    const flush = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const a = gate.check(SITE, 'createSignature');
    const b = gate.check(SITE, 'createAction');
    await flush();
    answers.shift()!({ status: 'ok', method: 'biometric' });
    expect(await Promise.all([a, b])).toEqual(['biometric', 'biometric']);
    expect(calls.length).toBe(1);

    const c = gate.check(SITE, 'createAction');
    const d = gate.check(SITE, 'createAction');
    await flush();
    answers.shift()!({ status: 'ok', method: 'biometric' });
    await flush();
    answers.shift()!({ status: 'ok', method: 'biometric' });
    await Promise.all([c, d]);
    expect(calls.length).toBe(3);
  });

  test('cancel: the standard BRC-100 denial, and no pass', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'cancelled' }));
    const err = await gate.check(SITE, 'createSignature').catch((e) => e);
    expect(err.code).toBe(USER_DENIED_CODE);
    expect(err.message).toBe('Permission denied.');
    await gate.check(SITE, 'createSignature').catch(() => undefined);
    expect(calls.length).toBe(2);
  });

  test('timeout: rejects with a coded error instead of hanging', async () => {
    const { gate, t } = gateWith(() => new Promise(() => undefined));
    const p = gate.check(SITE, 'createSignature').catch((e) => e);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(t.list[0].ms).toBe(60_000);
    t.fireAll();
    const err = await p;
    expect(err.code).toBe(VERIFICATION_TIMEOUT_CODE);
    expect(err.status).toBe(408);
  });

  test('no biometrics and no passcode: no prompt result, verifiedBy none', async () => {
    const { gate } = gateWith(async () => ({ status: 'unavailable' }));
    expect(await gate.check(SITE, 'createAction')).toBe('none');
    expect(gate.lastVerification(SITE)?.verifiedBy).toBe('none');
  });

  test('a broken native call falls back to none (approval sheets still apply)', async () => {
    const { gate } = gateWith(() => Promise.reject(new Error('plugin missing')));
    expect(await gate.check(SITE, 'createSignature')).toBe('none');
  });

  test('setting off: never prompts', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'ok', method: 'biometric' }), { enabled: false });
    expect(await gate.check(SITE, 'createSignature')).toBe('none');
    expect(calls).toEqual([]);
  });

  test('passes are per origin', async () => {
    const { gate, calls } = gateWith(async () => ({ status: 'ok', method: 'biometric' }));
    await gate.check(SITE, 'createSignature');
    await gate.check('https://evil.example', 'createSignature');
    expect(calls.length).toBe(2);
  });
});

describe('withSiteCeiling (bChatX endless "Sealing…")', () => {
  test('a wallet step that never answers becomes a timeout reply', async () => {
    const t = timers();
    const p = withSiteCeiling(new Promise(() => undefined), 120_000, t.setTimer, t.clearTimer);
    t.fireAll();
    expect(await p).toMatchObject({ success: false, code: SITE_CALL_TIMEOUT_CODE, status: 504 });
  });

  test('an answer in time passes through and clears the timer', async () => {
    const t = timers();
    const reply = { success: true, data: { signature: [1, 2] } };
    expect(await withSiteCeiling(Promise.resolve(reply), 120_000, t.setTimer, t.clearTimer)).toBe(reply);
    expect(t.list[0].live).toBe(false);
  });
});
