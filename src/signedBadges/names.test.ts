import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { SIGN_KEY_ID, SIGN_PROTOCOL, signedMessage } from '../mobile/names/paymail';
import { createNameCheck, signerFromName } from './names';
import type { VerifiedProof } from './record';

describe('signerFromName', () => {
  test.each([
    ['$alice', '$alice'],
    ['$Alice', '$alice'],
    ['alice@bwalletx.com', '$alice'],
    ['alice@bmailx.com', '$alice'],
    ['$alice@bwalletx.com', '$alice'],
    ['alice@handcash.io', undefined],
    ['alice', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%p → %p', (name, signer) => expect(signerFromName(name)).toBe(signer));
});

const priv = PrivateKey.fromHex('22'.repeat(32));
const pub = priv.toPublicKey().toString();
const owner = new ProtoWallet(priv);

const binding = async (alias: string, key: string) => {
  const fields = { alias, seq: '1', identityKey: key, timestamp: '1792200000000' };
  const { signature } = await owner.createSignature({
    data: Utils.toArray(signedMessage('bind', fields), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { alias, identityKey: key, seq: 1, timestamp: fields.timestamp, signature: Utils.toHex(signature) };
};

const fakeFetch = (pki: Record<string, unknown>) => {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
    if (url.includes('dns')) return json({});
    if (url.endsWith('/.well-known/bsvalias'))
      return json({ capabilities: { pki: 'https://bwalletx.com/api/paymail/id/{alias}@{domain.tld}' } });
    const alias = decodeURIComponent(url.split('/id/')[1]?.split('@')[0] ?? '');
    return alias in pki ? json(pki[alias]) : json({}, false);
  };
  return { f, calls };
};

describe('createNameCheck', () => {
  test('a name is shown only when its paymail key is the signer and the binding is signed by it', async () => {
    const { f } = fakeFetch({
      alice: { pubkey: pub, binding: await binding('alice', pub) },
      mallory: { pubkey: pub }, // no binding: our server alone can't vouch
      eve: { pubkey: '02' + 'e'.repeat(64), binding: await binding('eve', pub) },
    });
    const n = createNameCheck(f);
    expect(await n.nameMatches('$alice', pub)).toBe(true);
    expect(await n.nameMatches('$mallory', pub)).toBe(false);
    expect(await n.nameMatches('$eve', pub)).toBe(false);
    expect(await n.nameMatches('$nobody', pub)).toBe(false);
    expect(await n.nameMatches('alice', pub)).toBe(false);
  });

  test('nameProofs fills name only for checked claims, and caches', async () => {
    const { f, calls } = fakeFetch({ alice: { pubkey: pub, binding: await binding('alice', pub) } });
    const n = createNameCheck(f);
    const p = (claimedName?: string): VerifiedProof => ({
      key: 'x-post-1',
      content: 'c',
      publicKey: pub,
      signedAt: '2026-11-01T00:00:00.000Z',
      source: 'bwalletx',
      claimedName,
    });
    const byKey = { 'x-post-1': [p('$alice'), p('$bob'), p()] };
    await n.nameProofs(byKey);
    expect(byKey['x-post-1'].map((x) => x.name)).toEqual(['$alice', undefined, undefined]);
    const before = calls.length;
    await n.nameProofs({ 'x-post-1': [p('$alice')] });
    expect(calls.length).toBe(before);
  });
});
