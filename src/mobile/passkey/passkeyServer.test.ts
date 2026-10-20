import { describe, expect, test } from 'bun:test';
import { BSM, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';
import { putMessage, serverCopy, signedPut } from './passkeyServer';
import { openSeed, sealSeed, type SeedBackupBlob } from './seedBackup';

const prf = new Uint8Array(32).map((_, i) => i + 1);
const make = async (): Promise<SeedBackupBlob> =>
  sealSeed('abandon ability able about above absent absorb abstract absurd abuse access accident', prf, {
    rpId: 'bwalletx.com',
    credentialId: 'AAAAAAAAAAAAAAAAAAAAAA',
    label: "Richard's iPhone",
    account: '1ExampleIdentityAddress',
  });

describe('server copy of the passkey backup', () => {
  test('never carries the account address or the label (the public GET would leak them)', async () => {
    const blob = await make();
    expect(blob.account).toBe('1ExampleIdentityAddress');
    expect(blob.label).toBe("Richard's iPhone");
    const put = signedPut(blob, PrivateKey.fromRandom().toWif());
    expect(put.blob).not.toHaveProperty('account');
    expect(put.blob).not.toHaveProperty('label');
    expect(JSON.stringify(put)).not.toContain('1ExampleIdentityAddress');
    expect(JSON.stringify(put)).not.toContain('iPhone');
    // The caller's blob (local copy, recovery file) keeps both.
    expect(blob.account).toBe('1ExampleIdentityAddress');
  });

  test('the stripped copy still decrypts, and the signature covers exactly what is sent', async () => {
    const blob = await make();
    const key = PrivateKey.fromRandom();
    const put = signedPut(blob, key.toWif(), 1_700_000_000_000);
    expect(await openSeed(put.blob, prf)).toContain('abandon ability');
    const hash = Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(put.blob), 'utf8')));
    const msg = Utils.toArray(putMessage(put.blob.credentialId, hash, put.ts), 'utf8');
    expect(
      BSM.verify(msg, Signature.fromCompact(put.signature, 'base64'), PublicKey.fromString(put.identity_key)),
    ).toBe(true);
  });

  test('serverCopy leaves every other field alone', async () => {
    const blob = await make();
    const c = serverCopy(blob);
    expect(Object.keys(c).sort()).toEqual(['createdAt', 'credentialId', 'ct', 'iv', 'kind', 'rpId', 'salt', 'v']);
  });
});
