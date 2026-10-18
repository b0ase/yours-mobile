import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Script } from '@bsv/sdk';
import {
  makeDoc,
  mergeParts,
  parsePart,
  sealOnChain,
  sealScriptHex,
  signAgreement,
  verifySig,
  CONTENT_MAX,
} from './agreement';
import { bytesToSealed, sealedToBytes } from '../bmail/envelope';

const alice = new ProtoWallet(PrivateKey.fromRandom());
const bob = new ProtoWallet(PrivateKey.fromRandom());
const keyOf = async (w: ProtoWallet) => (await w.getPublicKey({ identityKey: true })).publicKey;
const SVG = 'M0 0L10 10Z';
const SVG_SHA = 'a'.repeat(64);

const doc = async () =>
  makeDoc({
    id: '0123456789abcdef',
    title: ' NDA ',
    mime: 'text/plain',
    content: 'Keep it secret.',
    author: await keyOf(alice),
    parties: [await keyOf(bob)],
    createdAt: 1,
  });

describe('agreements', () => {
  test('makeDoc hashes the bytes, trims the title and includes the author', async () => {
    const d = await doc();
    expect(d.title).toBe('NDA');
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.parties).toEqual([await keyOf(alice), await keyOf(bob)]);
    expect(() => makeDoc({ ...d, content: 'x'.repeat(CONTENT_MAX + 1) })).toThrow();
  });

  test('a signature verifies for its signer and fails for anyone else', async () => {
    const d = await doc();
    const s = await signAgreement(bob, await keyOf(bob), d, SVG, SVG_SHA, 5);
    expect(await verifySig(d, s)).toBe(true);
    expect(await verifySig(d, { ...s, key: await keyOf(alice) })).toBe(false);
    expect(await verifySig({ ...d, sha256: 'b'.repeat(64) }, s)).toBe(false);
  });

  test('a non-party cannot sign', async () => {
    const d = await doc();
    const carol = new ProtoWallet(PrivateKey.fromRandom());
    await expect(signAgreement(carol, await keyOf(carol), d, SVG, SVG_SHA)).rejects.toThrow();
  });

  test('parsePart rejects a tampered document and survives the bMail envelope', async () => {
    const d = await doc();
    const part = { doc: d, sigs: [await signAgreement(alice, d.author, d, SVG, SVG_SHA, 2)] };
    const back = bytesToSealed(sealedToBytes({ subject: 's', body: 'b', agreement: part }));
    expect(parsePart(back.agreement)).toEqual(part);
    expect(parsePart({ ...part, doc: { ...d, content: 'Tell everyone.' } })).toBeNull();
    expect(parsePart(null)).toBeNull();
  });

  test('mergeParts unions signatures and keeps the earliest seal; a different document is ignored', async () => {
    const d = await doc();
    const a = await signAgreement(alice, d.author, d, SVG, SVG_SHA, 2);
    const b = await signAgreement(bob, await keyOf(bob), d, SVG, SVG_SHA, 3);
    const seal1 = { txid: 'c'.repeat(64), at: 10, by: d.author };
    const seal2 = { txid: 'd'.repeat(64), at: 5, by: d.author };
    const other = makeDoc({ ...d, content: 'different' });
    const [m] = mergeParts([
      { doc: d, sigs: [a], seal: seal1 },
      { doc: d, sigs: [b, a], seal: seal2 },
      { doc: other, sigs: [] },
    ]);
    expect(m.sigs.map((s) => s.key)).toEqual([a.key, b.key]);
    expect(m.seal).toEqual(seal2);
  });

  test('the seal is one 0-sat OP_RETURN with hashes only', async () => {
    const d = await doc();
    const part = { doc: d, sigs: [] };
    const hex = sealScriptHex(part);
    const chunks = Script.fromHex(hex).chunks;
    expect(chunks[0].op).toBe(0);
    expect(chunks[1].op).toBe(0x6a);
    expect(hex).not.toContain(Buffer.from('Keep it secret.').toString('hex'));
    let args: unknown = null;
    const seal = await sealOnChain(
      { createAction: async (a) => ((args = a), { txid: 'E'.repeat(64) }) },
      d.author,
      part,
      7,
    );
    expect(seal).toEqual({ txid: 'e'.repeat(64), at: 7, by: d.author });
    expect((args as { outputs: { satoshis: number; lockingScript: string }[] }).outputs).toEqual([
      { satoshis: 0, lockingScript: hex, outputDescription: 'Agreement seal' },
    ]);
  });
});
