import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

// The account-change check remembers the first account in localStorage. Depending on which test files ran first in the
// same process, CI had none (or a stub that keeps nothing), so the check could not fire. Use a fresh in-memory one here
// and put the previous one back afterwards.
const g = globalThis as { localStorage?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.localStorage;
  const mem = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
});
afterAll(() => {
  g.localStorage = saved;
});

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
