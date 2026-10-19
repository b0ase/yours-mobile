import { describe, expect, test } from 'bun:test';
import { BSM, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';
import {
  deriveOpen,
  isWalletOrigin,
  OPEN_LIFETIME_S,
  openOpen,
  openUrl,
  parseOpenUrl,
  sealOpen,
  type OpenLink,
} from './openHere';
import { fetchBackup, putMessage, signedPut } from './passkeyServer';
import { b64url, sealSeed } from './seedBackup';

const NOW = 1_800_000_000;
const channel = 'AAAAAAAAAAAAAAAAAAAAAA';
const computer = PrivateKey.fromRandom();
const phone = PrivateKey.fromRandom();
const link = (o: Partial<OpenLink> = {}): OpenLink => ({
  v: '1',
  r: 'relay.bwallet.space',
  c: channel,
  k: computer.toPublicKey().toString(),
  o: 'https://web.bwalletx.com',
  e: NOW + OPEN_LIFETIME_S,
  ...o,
});

describe('open on computer: QR', () => {
  test('carries only public data and parses back', () => {
    const u = openUrl(link());
    expect(u).toContain('/open?');
    expect(u).not.toMatch(/words|mnemonic|wif/i);
    expect(parseOpenUrl(u, NOW)).toEqual(link());
  });
  test('refuses non-bWalletX origins (and lookalikes)', () => {
    for (const o of [
      'https://evil.example',
      'https://bwalletx.com.evil.example',
      'http://web.bwalletx.com',
      'https://notbwalletx.com',
    ])
      expect(() => parseOpenUrl(openUrl(link({ o })), NOW)).toThrow();
    expect(isWalletOrigin('https://desktop.bwalletx.com')).toBe(true);
    expect(isWalletOrigin('http://localhost:4797')).toBe(false);
    expect(isWalletOrigin('http://localhost:4797', true)).toBe(true);
  });
  test('expires after 2 minutes and refuses a too-long expiry', () => {
    expect(() => parseOpenUrl(openUrl(link()), NOW + OPEN_LIFETIME_S + 1)).toThrow('expired');
    expect(() => parseOpenUrl(openUrl(link({ e: NOW + 3600 })), NOW)).toThrow();
  });
});

describe('open on computer: crypto', () => {
  test('both sides get the same key and the same 4-digit code', async () => {
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    expect(a.code).toBe(b.code);
    expect(a.code).toMatch(/^\d-\d-\d-\d$/);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'one two three', exp: NOW + 60 });
    expect(JSON.stringify(f)).not.toContain('one two');
    expect((await openOpen(b.key, channel, f, NOW)).words).toBe('one two three');
  });
  test('a man in the middle gets a different code and cannot open the payload', async () => {
    const mitm = PrivateKey.fromRandom();
    const phoneSide = await deriveOpen(phone, mitm.toPublicKey().toString(), channel);
    const computerSide = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    expect(phoneSide.code).not.toBe(computerSide.code);
    const f = await sealOpen(phoneSide.key, channel, { t: 'wallet', words: 'x y z', exp: NOW + 60 });
    await expect(openOpen(computerSide.key, channel, f, NOW)).rejects.toThrow();
  });
  test('bound to its channel and refused after expiry', async () => {
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'a b c', exp: NOW + 60 });
    await expect(openOpen(b.key, 'BBBBBBBBBBBBBBBBBBBBBB', f, NOW)).rejects.toThrow();
    await expect(openOpen(b.key, channel, f, NOW + 61)).rejects.toThrow('Expired');
  });
});

describe('server backup store client', () => {
  test('signed upload verifies against the identity key and binds the blob', async () => {
    const id = PrivateKey.fromRandom();
    const blob = await sealSeed('one two three', new Uint8Array(32).fill(1), {
      rpId: 'bwalletx.com',
      credentialId: b64url(new Uint8Array(16).fill(5)),
    });
    const body = signedPut(blob, id.toWif(), 1234);
    expect(body.identity_key).toBe(id.toPublicKey().toString());
    const hash = Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(blob), 'utf8')));
    const msg = Utils.toArray(putMessage(blob.credentialId, hash, 1234), 'utf8');
    expect(
      BSM.verify(msg, Signature.fromCompact(body.signature, 'base64'), PublicKey.fromString(body.identity_key)),
    ).toBe(true);
    const other = Utils.toArray(putMessage(blob.credentialId, '00'.repeat(32), 1234), 'utf8');
    expect(
      BSM.verify(other, Signature.fromCompact(body.signature, 'base64'), PublicKey.fromString(body.identity_key)),
    ).toBe(false);
  });
  test('fetch returns only a valid blob for the asked credential id', async () => {
    const blob = await sealSeed('one two three', new Uint8Array(32).fill(1), {
      rpId: 'bwalletx.com',
      credentialId: b64url(new Uint8Array(16).fill(5)),
    });
    const ok = (async () => new Response(JSON.stringify({ blob }))) as unknown as typeof fetch;
    expect((await fetchBackup(blob.credentialId, ok))?.ct).toBe(blob.ct);
    expect(await fetchBackup('somethingElse_123456', ok)).toBeNull();
    const nf = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchBackup(blob.credentialId, nf)).toBeNull();
  });
});

describe('"your phone has it" ping', () => {
  test('fingerprint is stable, normalised and does not reveal the words', async () => {
    const { walletFingerprint } = await import('./openHere');
    const a = await walletFingerprint('Abandon  ability able');
    expect(a).toBe(await walletFingerprint('abandon ability able'));
    expect(a).not.toBe(await walletFingerprint('abandon ability about'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  test('ping params are validated and expire', async () => {
    const { parsePing, pingQuery, RESTORED_LIFETIME_S } = await import('./openHere');
    const p = { r: 'relay.bwallet.space', c: channel, k: computer.toPublicKey().toString(), e: NOW + 100 };
    expect(parsePing('?passkey=1' + pingQuery(p), NOW)).toEqual(p);
    expect(parsePing('?passkey=1' + pingQuery(p), NOW + 101)).toBeNull();
    expect(parsePing('?passkey=1' + pingQuery({ ...p, e: NOW + RESTORED_LIFETIME_S + 3600 }), NOW)).toBeNull();
    expect(parsePing('?passkey=1' + pingQuery({ ...p, k: 'nope' }), NOW)).toBeNull();
    expect(parsePing('?passkey=1', NOW)).toBeNull();
  });
  test('restored-ping keys are separate from open-on-computer keys', async () => {
    const { RESTORED_INFO } = await import('./openHere');
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(phone, computer.toPublicKey().toString(), channel, RESTORED_INFO);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'x', exp: NOW + 60 });
    await expect(openOpen(b.key, channel, f, NOW)).rejects.toThrow();
  });
});

describe('biometric confirm', () => {
  test('is unavailable (password fallback) where biometric unlock was never set up', async () => {
    const { confirmWithBiometrics } = await import('../biometricUnlock');
    expect(await confirmWithBiometrics('test')).toBe('unavailable');
  });
});
