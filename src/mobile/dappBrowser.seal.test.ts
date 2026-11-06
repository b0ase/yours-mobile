/**
 * One Seal sheet, one Face ID (services/sealPass.ts, owner 2 Nov 2026): when the background says the person approved
 * the Seal sheet, the bridge keeps the Face ID pass for the seal payment and never passes the marker to the site.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

const extended: string[] = [];
const fakeGate = {
  check: async () => 'biometric' as const,
  lastVerification: () => null,
  extendPass: (origin: string) => {
    extended.push(origin);
  },
};

let handleSiteCall: typeof import('./dappBrowser').handleSiteCall;
let sealApproved = true;
beforeAll(async () => {
  const m = await import('./dappBrowser');
  handleSiteCall = m.handleSiteCall;
  m.__setSiteGateForTests(fakeGate);
  m.initDappBrowser(() => ({
    runtime: {
      sendMessage: (msg: { action: string }) =>
        Promise.resolve(
          msg.action === 'createSignature'
            ? { success: true, data: { signature: [1, 2, 3] }, ...(sealApproved ? { sealApproved: true } : {}) }
            : { success: true, data: {} },
        ),
    },
  }));
});

const ORIGIN = 'https://chat.bwalletx.com';

describe('handleSiteCall after a Seal sheet', () => {
  test('approved seal: the Face ID pass is kept for the payment; the site sees only the signature', async () => {
    const r = (await handleSiteCall(ORIGIN, `${ORIGIN}/room/BCORPBOARD`, 'createSignature', {})) as Record<
      string,
      unknown
    >;
    expect(r).toEqual({ success: true, data: { signature: [1, 2, 3] } });
    expect(extended).toEqual([ORIGIN]);
  });

  test('any other signature: nothing kept', async () => {
    sealApproved = false;
    await handleSiteCall(ORIGIN, `${ORIGIN}/room/BCORPBOARD`, 'createSignature', {});
    await handleSiteCall(ORIGIN, `${ORIGIN}/room/BCORPBOARD`, 'createAction', {});
    expect(extended).toEqual([ORIGIN]);
  });
});
