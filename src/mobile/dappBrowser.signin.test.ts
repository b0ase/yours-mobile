/**
 * In-app dApp browser and framed bApps (handleSiteCall): a sign-in signature is bound to the verified origin the call
 * came from (security review, 2 Nov 2026). Another site's challenge, or the hub's protocol from anywhere but the hub,
 * is refused before the Face ID gate and before the wallet is asked anything.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import { hubMessage, loginMessage, SIGN_IN_REFUSAL } from '../services/signInBinding';

const gateCalls: string[] = [];
const reached: { action: string; originator: string }[] = [];
let handleSiteCall: typeof import('./dappBrowser').handleSiteCall;

beforeAll(async () => {
  const m = await import('./dappBrowser');
  handleSiteCall = m.handleSiteCall;
  m.__setSiteGateForTests(
    {
      check: async (_o: string, call: string) => {
        gateCalls.push(call);
        return 'biometric' as const;
      },
      lastVerification: () => null as never,
    },
    () => 1000,
  );
  m.initDappBrowser(() => ({
    runtime: {
      sendMessage: async (msg: { action: string; originator: string }) => {
        reached.push({ action: msg.action, originator: msg.originator });
        return { success: true, data: { signature: [1] } };
      },
    },
  }));
});

const GOOD = 'https://good-signin.example';
const EVIL = 'https://evil-signin.example';
const HUB = 'https://id.bwalletx.com';
const NONCE = 'n0nce_abcdefghijk';
const sig = (protocol: string, text: string) => ({
  protocolID: [2, protocol],
  keyID: NONCE,
  counterparty: 'anyone',
  data: Utils.toArray(text, 'utf8'),
});
const soon = () => new Date(Date.now() + 60_000).toISOString();
const reset = () => {
  gateCalls.length = 0;
  reached.length = 0;
};

describe('handleSiteCall binds sign-ins to the calling origin', () => {
  test("a foreign origin's challenge is refused before the gate and the wallet", async () => {
    reset();
    const r = await handleSiteCall(
      EVIL,
      `${EVIL}/`,
      'createSignature',
      sig('bwallet sign in', loginMessage(GOOD, NONCE, soon())),
    );
    expect(r).toMatchObject({ success: false, code: 'ERR_PROTOCOL_REFUSED' });
    expect((r as { error: string }).error).toContain(SIGN_IN_REFUSAL);
    expect(gateCalls).toEqual([]);
    expect(reached).toEqual([]);
  });

  test("the hub's challenge relayed by another site is refused, under either protocol", async () => {
    reset();
    for (const p of ['bwallet sign in', 'bwalletx id sign in']) {
      const text =
        p === 'bwallet sign in' ? loginMessage(HUB, NONCE, soon()) : hubMessage(HUB, NONCE, new Date().toISOString());
      const r = await handleSiteCall(EVIL, `${EVIL}/`, 'createSignature', sig(p, text));
      expect(r).toMatchObject({ success: false });
    }
    // The hub protocol is the hub's alone, whatever the method.
    const k = await handleSiteCall(EVIL, `${EVIL}/`, 'getPublicKey', {
      protocolID: [2, 'bwalletx id sign in'],
      keyID: '1',
    });
    expect(k).toMatchObject({ success: false });
    expect(gateCalls).toEqual([]);
    expect(reached).toEqual([]);
  });

  test('malformed sign-in text is refused', async () => {
    reset();
    const r = await handleSiteCall(
      GOOD,
      `${GOOD}/`,
      'createSignature',
      sig('bwallet sign in', 'Sign in to good-signin.example'),
    );
    expect(r).toMatchObject({ success: false });
    expect(reached).toEqual([]);
  });

  test("the site's own challenge goes on to the gate and the wallet (whose sheet then asks)", async () => {
    reset();
    const r = await handleSiteCall(
      GOOD,
      `${GOOD}/`,
      'createSignature',
      sig('bwallet sign in', loginMessage(GOOD, NONCE, soon())),
    );
    expect(r).toEqual({ success: true, data: { signature: [1] } });
    expect(gateCalls).toEqual(['createSignature']);
    expect(reached).toEqual([{ action: 'createSignature', originator: 'good-signin.example' }]);
  });
});
