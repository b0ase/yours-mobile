import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { checkGistProof, checkNameProof, gistStatement, provableProvider, verifyGistText } from './proof';

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

describe('GitHub gist proofs: a superseded key replayed (third review, finding 2)', () => {
  const ALIAS2 = 'octo-dog.github';
  const signedBy = async (p: PrivateKey) => {
    const st = gistStatement(ALIAS2, p.toPublicKey().toString());
    const { signature } = await new ProtoWallet(p).createSignature({
      data: Utils.toArray(st, 'utf8'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: 'anyone',
    });
    return `${st}\n${Utils.toHex(signature)}\n`;
  };
  test('K0 proven at seq 1, K1 at seq 2: K0 with its old gist and seq-1 binding is not proven', async () => {
    const p0 = PrivateKey.fromRandom();
    const p1 = PrivateKey.fromRandom();
    const k0 = p0.toPublicKey().toString();
    const k1 = p1.toPublicKey().toString();
    const proof = { provider: 'github', gist: 'b'.repeat(32) };
    const f0 = gistFetch('octo-dog', await signedBy(p0));
    const f1 = gistFetch('octo-dog', await signedBy(p1));
    expect((await checkNameProof(f0, ALIAS2, k0, proof, { seq: 1 }))?.status).toBe('proven');
    expect((await checkNameProof(f1, ALIAS2, k1, proof, { seq: 2 }))?.status).toBe('proven');
    expect((await checkNameProof(f0, ALIAS2, k0, proof, { seq: 1 }))?.status).toBe('bad');
    expect((await checkNameProof(f0, ALIAS2, k0, proof))?.status).toBe('bad');
    expect((await checkNameProof(f1, ALIAS2, k1, proof, { seq: 2 }))?.status).toBe('proven');
  });
});

describe("GitHub gist proofs: ordered by GitHub's created_at, not only the self-signed seq (fourth review)", () => {
  const ALIAS3 = 'octo-fox.github';
  const signedBy = async (p: PrivateKey) => {
    const st = gistStatement(ALIAS3, p.toPublicKey().toString());
    const { signature } = await new ProtoWallet(p).createSignature({
      data: Utils.toArray(st, 'utf8'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: 'anyone',
    });
    return `${st}\n${Utils.toHex(signature)}\n`;
  };
  const gistAt = (text: string, created: string) =>
    (async () =>
      new Response(
        JSON.stringify({
          owner: { login: 'octo-fox', id: 7 },
          created_at: created,
          updated_at: created,
          files: { 'proof.txt': { content: text } },
        }),
      )) as never;

  test("compromised K0 re-signs its binding at seq 3 with its old gist: refused; a newer gist still passes", async () => {
    const p0 = PrivateKey.fromRandom();
    const p1 = PrivateKey.fromRandom();
    const p2 = PrivateKey.fromRandom();
    const k0 = p0.toPublicKey().toString();
    const k1 = p1.toPublicKey().toString();
    const k2 = p2.toPublicKey().toString();
    const g0 = { provider: 'github', gist: 'c'.repeat(32) };
    const g1 = { provider: 'github', gist: 'd'.repeat(32) };
    const g2 = { provider: 'github', gist: 'e'.repeat(32) };
    const f0 = gistAt(await signedBy(p0), '2026-01-01T00:00:00Z');
    const f1 = gistAt(await signedBy(p1), '2026-02-01T00:00:00Z');
    const f2 = gistAt(await signedBy(p2), '2026-03-01T00:00:00Z');
    expect((await checkNameProof(f0, ALIAS3, k0, g0, { seq: 1 }))?.status).toBe('proven');
    expect((await checkNameProof(f1, ALIAS3, k1, g1, { seq: 2 }))?.status).toBe('proven');
    expect((await checkNameProof(f0, ALIAS3, k0, g0, { seq: 3 }))?.status).toBe('bad');
    expect((await checkNameProof(f0, ALIAS3, k0, g0))?.status).toBe('bad');
    expect((await checkNameProof(f2, ALIAS3, k2, g2, { seq: 3 }))?.status).toBe('proven');
  });
});
