import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { CLAIM_KEY_ID, CLAIM_PROTOCOL, claimMessage, needsPaymailHandle, signHandleClaim } from './bchatHandle';

describe('bChat handle = paymail name', () => {
  test('message matches bit-sign (src/lib/paymail-handle.ts claimMessage)', () => {
    expect(claimMessage('$Yours-Abc', 'Testy@bwallet.space', 1)).toBe(
      'bit-sign|claim-paymail-handle|v1|handle=yours-abc|paymail=testy@bwallet.space|timestamp=1',
    );
  });

  test('only a yours-* default that differs from the alias needs updating', () => {
    expect(needsPaymailHandle('yours-jorv3rmo', 'testy@bwallet.space')).toBe(true);
    expect(needsPaymailHandle('testy', 'testy@bwallet.space')).toBe(false);
    expect(needsPaymailHandle('boase', 'testy@bwallet.space')).toBe(false);
    expect(needsPaymailHandle('yours-abc', '')).toBe(false);
    expect(needsPaymailHandle(null, 'testy@bwallet.space')).toBe(false);
  });

  test('the proof verifies the way bit-sign checks it (anyone ↔ identity key)', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const proof = await signHandleClaim(wallet, 'yours-abc', 'Testy@bwallet.space', 1234);
    expect(proof.paymail).toBe('testy@bwallet.space');
    const verify = (handle: string) =>
      new ProtoWallet('anyone')
        .verifySignature({
          data: Utils.toArray(claimMessage(handle, proof.paymail, proof.timestamp), 'utf8'),
          signature: Utils.toArray(proof.signature, 'hex'),
          protocolID: CLAIM_PROTOCOL,
          keyID: CLAIM_KEY_ID,
          counterparty: proof.identity_key,
        })
        .then((r) => r.valid)
        .catch(() => false);
    expect(await verify('yours-abc')).toBe(true);
    expect(await verify('yours-other')).toBe(false);
  });
});
