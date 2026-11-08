/**
 * bChatX repro (29 Oct 2026): in the phone frame, connect → waitForAuthentication → getPublicKey → createSignature →
 * getPublicKey; one call never resolved ("Sealing…" forever). Every call through handleSiteCall must settle, and the
 * sign must pass the biometric gate first.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

const gateCalls: string[] = [];
let gateAnswer: 'ok' | 'deny' = 'ok';
const fakeGate = {
  check: async (_o: string, call: string) => {
    if (call !== 'createSignature' && call !== 'createAction') return null;
    gateCalls.push(call);
    if (gateAnswer === 'deny')
      throw Object.assign(new Error('Permission denied.'), { code: 'ERR_PERMISSION_DENIED', status: 403 });
    return 'biometric' as const;
  },
  lastVerification: () => ({
    verifiedBy: 'biometric' as const,
    at: '2026-10-29T00:00:00.000Z',
    call: 'createSignature' as const,
  }),
};

let handleSiteCall: typeof import('./dappBrowser').handleSiteCall;
const reached: string[] = [];
const timedOut: string[] = [];
let committed = false;
// BRC-219: the background says a sheet of the site is still on screen (the person is being asked).
let asking = false;
beforeAll(async () => {
  const m = await import('./dappBrowser');
  handleSiteCall = m.handleSiteCall;
  m.__setSiteGateForTests(fakeGate, () => 50);
  m.setSiteTimeoutNotifier(async (o) => {
    timedOut.push(o);
    if (asking) return { success: true, data: { cancelled: 0, committed: false, asking: true } };
    return { success: true, data: { cancelled: committed ? 0 : 1, committed } };
  });
  m.initDappBrowser(() => ({
    runtime: {
      sendMessage: (msg: { action: string }) => {
        reached.push(msg.action);
        // The step that hung on the phone: createSignature never answers.
        if (msg.action === 'createSignature') return new Promise(() => undefined);
        // A payment approved and still broadcasting when the limit hits: answers a bit later.
        if (msg.action === 'createAction')
          return new Promise((r) => setTimeout(() => r({ success: true, data: { txid: 'ab' } }), 120));
        // A sheet the person reads for a while (several ceilings), then Allows.
        if (msg.action === 'encrypt')
          return new Promise((r) => setTimeout(() => r({ success: true, data: { ciphertext: [9] } }), 260));
        return Promise.resolve({ success: true, data: { publicKey: '02ab' } });
      },
    },
  }));
});

const ORIGIN = 'https://www.bchatx.com';
const URL_ = `${ORIGIN}/room/BCORPBOARD`;

describe('handleSiteCall settles every step', () => {
  test('the bChatX sign sequence resolves or rejects, never hangs', async () => {
    expect(await handleSiteCall(ORIGIN, URL_, 'waitForAuthentication', {})).toMatchObject({ success: true });
    expect(await handleSiteCall(ORIGIN, URL_, 'getPublicKey', { keyID: 'identity', forSelf: true })).toMatchObject({
      success: true,
    });
    const signed = await handleSiteCall(ORIGIN, URL_, 'createSignature', {
      keyID: 'identity',
      counterparty: 'self',
      hashToDirectlySign: new Array(32).fill(1),
    });
    expect(signed).toMatchObject({ success: false, code: 'ERR_WALLET_TIMEOUT' });
    expect(gateCalls).toEqual(['createSignature']);
    expect(await handleSiteCall(ORIGIN, URL_, 'getPublicKey', { keyID: 'identity', forSelf: true })).toMatchObject({
      success: true,
    });
  });

  test('cancelled Face ID: clean denial, the wallet is never asked to sign', async () => {
    gateAnswer = 'deny';
    reached.length = 0;
    const r = await handleSiteCall(ORIGIN, URL_, 'createSignature', { data: [1] });
    expect(r).toMatchObject({ success: false, code: 'ERR_PERMISSION_DENIED' });
    expect(reached).toEqual([]);
    gateAnswer = 'ok';
  });

  test('getLastVerification answers without the wallet', async () => {
    reached.length = 0;
    expect(await handleSiteCall(ORIGIN, URL_, 'getLastVerification', {})).toEqual({
      success: true,
      data: { verifiedBy: 'biometric', at: '2026-10-29T00:00:00.000Z', call: 'createSignature' },
    });
    expect(reached).toEqual([]);
  });

  test('a timed-out sign closes the site sheets and reports the timeout', async () => {
    timedOut.length = 0;
    const r = await handleSiteCall(ORIGIN, URL_, 'createSignature', { data: [1] });
    expect(r).toMatchObject({ code: 'ERR_WALLET_TIMEOUT' });
    expect(timedOut).toEqual(['www.bchatx.com']);
  });

  test('a payment whose sheet was closed reports the timeout (nothing can be approved late)', async () => {
    committed = false;
    expect(await handleSiteCall(ORIGIN, URL_, 'createAction', {})).toMatchObject({ code: 'ERR_WALLET_TIMEOUT' });
  });

  test('an already approved payment never reports a timeout: the real answer comes back', async () => {
    committed = true;
    expect(await handleSiteCall(ORIGIN, URL_, 'createAction', {})).toEqual({ success: true, data: { txid: 'ab' } });
    committed = false;
  });
});

describe('BRC-219: the bridge waits while the person is being asked', () => {
  test('a sheet on screen past the ceiling: no timeout, the real answer comes back; nothing on screen still times out', async () => {
    asking = true;
    timedOut.length = 0;
    const r = await handleSiteCall(ORIGIN, URL_, 'encrypt', { plaintext: [1], protocolID: [1, 'x'], keyID: '1' });
    asking = false;
    expect(r).toEqual({ success: true, data: { ciphertext: [9] } });
    // The ceiling (50 ms here) hit several times; each time the background said "still asking" and closed nothing.
    expect(timedOut.length).toBeGreaterThan(1);
    // Nothing asking any more: the ceiling still ends a step that hangs with nothing on screen.
    expect(await handleSiteCall(ORIGIN, URL_, 'createSignature', { data: [1] })).toMatchObject({
      code: 'ERR_WALLET_TIMEOUT',
    });
  });

  test('a payment sheet on screen past the 300 s ceiling is not closed: the real answer comes back', async () => {
    asking = true;
    committed = false;
    timedOut.length = 0;
    const r = await handleSiteCall(ORIGIN, URL_, 'createAction', {});
    asking = false;
    expect(r).toEqual({ success: true, data: { txid: 'ab' } });
    expect(timedOut.length).toBeGreaterThan(0);
  });
});
