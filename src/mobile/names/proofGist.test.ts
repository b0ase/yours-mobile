import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { checkGistProof, gistStatement, provableProvider, verifyGistText } from './proof';

const priv = PrivateKey.fromRandom();
const KEY = priv.toPublicKey().toString();
const ALIAS = 'octo-cat.github';
const signed = async () => {
  const st = gistStatement(ALIAS, KEY);
  const { signature } = await new ProtoWallet(priv).createSignature({
    data: Utils.toArray(st, 'utf8'),
    protocolID: [2, 'bwallet paymail'],
    keyID: '1',
    counterparty: 'anyone',
  });
  return `${st}\n${Utils.toHex(signature)}\n`;
};
const gistFetch = (login: string, text: string, id = 42) =>
  (async () =>
    new Response(JSON.stringify({ owner: { login, id }, files: { 'proof.txt': { content: text } } }))) as never;

describe('GitHub gist proofs (wallet side)', () => {
  test('statement + signature by this key', async () => {
    const text = await signed();
    expect(await verifyGistText(text, ALIAS, KEY)).toBe(true);
    expect(await verifyGistText(text, ALIAS, PrivateKey.fromRandom().toPublicKey().toString())).toBe(false);
  });
  test('proven only when the gist owner is the login; account change stops', async () => {
    const text = await signed();
    const proof = { provider: 'github', gist: 'a'.repeat(32) };
    expect((await checkGistProof(gistFetch('Octo-Cat', text), ALIAS, KEY, proof)).status).toBe('proven');
    expect((await checkGistProof(gistFetch('mallory', text), ALIAS, KEY, proof)).status).toBe('bad');
    expect((await checkGistProof(gistFetch('octo-cat', text, 99), ALIAS, KEY, proof)).status).toBe('sub-changed');
  });
  test('.linkedin names are provable by LinkedIn', () => {
    expect(provableProvider('richardboase.linkedin')).toBe('linkedin');
  });
});
