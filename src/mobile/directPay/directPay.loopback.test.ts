/**
 * Phone to phone over a REAL WebRTC data channel: two wallets in one process, the QR code exchange done in memory,
 * everything else (DTLS, identity handshake under [2, 'webrtpay channel'], payment, ack) for real.
 *
 * Needs node-datachannel, a native module the app does not depend on. Skipped unless WEBRTPAY_NDC points at an
 * installed copy, e.g.:
 *   mkdir /tmp/ndc && cd /tmp/ndc && pnpm add node-datachannel   (needs its prebuilt or a cmake build)
 *   WEBRTPAY_NDC=/tmp/ndc/node_modules/node-datachannel bun test src/mobile/directPay/directPay.loopback.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  createDirectPayClient,
  payOverChannel,
  pendingStore,
  previewOffer,
  receiveHandlers,
  seenStore,
} from './directPay';
import type { RtcOptions } from '../../vendor/webrtpay/index';
import { makeTestWallet, memoryKV } from './testkit';
import type { Received } from './directPay';

const NDC = process.env.WEBRTPAY_NDC;

const loopbackRtc = async (): Promise<RtcOptions> => {
  const { RTCPeerConnection } = await import(`${NDC}/dist/esm/polyfill/index.mjs`);
  return {
    RTCPeerConnection: RTCPeerConnection as typeof globalThis.RTCPeerConnection,
    iceServers: [],
    extraConfig: { bindAddress: '127.0.0.1' } as RTCConfiguration,
  };
};

describe.skipIf(!NDC)('phone to phone: loopback over node-datachannel', () => {
  afterAll(async () => {
    const { cleanup } = await import(`${NDC}/dist/esm/lib/index.mjs`);
    cleanup();
  });

  test('offer QR → approve → answer QR → paid, internalized once, both sides see it', async () => {
    const rtc = await loopbackRtc();
    const payer = makeTestWallet();
    const payee = makeTestWallet();
    const payeeClient = createDirectPayClient(payee.wallet, rtc);
    const payerClient = createDirectPayClient(payer.wallet, rtc);

    let got: Received | undefined;
    const handlers = receiveHandlers({
      wallet: payee.wallet,
      seen: seenStore(memoryKV()),
      onReceived: (r) => (got = r),
    });
    // Payee shows the offer code.
    const offer = await payeeClient.createOfferCode({ amount: 2500, expiresInMs: 60_000, handlers });
    // Payer scans it, reviews (no ICE yet), approves, answers.
    const preview = previewOffer(offer.code);
    expect(preview.amount).toBe(2500);
    const answer = await payerClient.answerOfferCode(offer.code);
    // Payee scans the answer code.
    const [payeeSession, peer] = await Promise.all([offer.complete(answer.answerCode), answer.connected]);
    expect(payeeSession.peerIdentityKey).toBe((await payer.wallet.getPublicKey({ identityKey: true })).publicKey);
    expect(peer.peerIdentityKey).toBe(preview.identityKey);

    const pending = pendingStore(memoryKV());
    const r = await payOverChannel({ client: payerClient, wallet: payer.wallet, peer, sats: 2500, pending });
    expect(r).toMatchObject({ k: 'paid', sats: 2500, ack: 'accepted' });
    expect(payer.calls.broadcast).toHaveLength(1);
    expect(payee.calls.internalize).toHaveLength(1);
    expect(got).toMatchObject({ sats: 2500, duplicate: false });
    expect(pending.get(peer.peerIdentityKey)).toBeNull();

    await payerClient.close();
    await payeeClient.close();
  }, 60_000);
});
