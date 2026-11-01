import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { AUTHSIG_MAINNET_RECORD } from './fixtures';
import { decodeProofValue } from './record';
import { estimateProofSats, sha256Hex, signProof, verifyEntry, type KvEntry, type ProofStore } from './verify';

const real = (): KvEntry => ({ ...AUTHSIG_MAINNET_RECORD, protocolID: [...AUTHSIG_MAINNET_RECORD.protocolID] });

describe('verifyEntry: AuthSig records', () => {
  test('a real mainnet AuthSig proof verifies', async () => {
    const p = await verifyEntry(real());
    expect(p).not.toBeNull();
    expect(p!.content).toBe('How many switch ports total');
    expect(p!.publicKey).toBe(AUTHSIG_MAINNET_RECORD.controller);
    expect(p!.outpoint).toBe(`${AUTHSIG_MAINNET_RECORD.token.txid}.0`);
    expect(p!.source).toBe('authsig');
    expect(p!.signedAt).toBe('2026-10-30T23:47:49.955Z');
  });

  test('changed content is refused (signature and hash no longer match)', async () => {
    const v = JSON.parse(AUTHSIG_MAINNET_RECORD.value);
    expect(
      await verifyEntry({ ...real(), value: JSON.stringify({ ...v, content: 'How many switch ports?' }) }),
    ).toBeNull();
    // Even with a matching hash, the signature still fails.
    const content = 'How many switch ports?';
    const forged = JSON.stringify({ ...v, content, contentHash: sha256Hex(content) });
    expect(await verifyEntry({ ...real(), value: forged })).toBeNull();
  });

  test('a record whose publicKey is not the token controller is refused', async () => {
    expect(await verifyEntry({ ...real(), controller: '02' + 'a'.repeat(64) })).toBeNull();
  });

  test('another protocol under the same key is refused', async () => {
    expect(await verifyEntry({ ...real(), protocolID: [1, 'kvstore'] })).toBeNull();
  });

  test('a key that is neither x-post nor the content hash is refused', async () => {
    expect(await verifyEntry({ ...real(), key: 'something-else' })).toBeNull();
    expect(await verifyEntry({ ...real(), key: 'f'.repeat(64) })).toBeNull();
  });
});

describe('signProof → verifyEntry round trip (what bWalletX writes, AuthSig and we both read)', () => {
  const wallet = new ProtoWallet(PrivateKey.fromHex('11'.repeat(32)));
  const fakeStore = () => {
    const writes: { key: string; value: string; options: unknown }[] = [];
    const store: ProofStore = {
      set: async (key, value, options) => {
        writes.push({ key, value, options });
        return `${'ab'.repeat(32)}.0`;
      },
    };
    return { store, writes };
  };

  test('a post on X: x-post key, AuthSig fields first, verifies', async () => {
    const { store, writes } = fakeStore();
    const content = 'Signed from bWalletX 🟡\nline two';
    const r = await signProof(
      wallet,
      store,
      {
        key: 'x-post-1234567890',
        content,
        extras: {
          signer: '$alice',
          pageUrl: 'https://x.com/alice/status/1234567890',
          platform: 'x.com',
          postId: '1234567890',
        },
      },
      () => new Date('2026-11-01T12:00:00.000Z'),
    );
    expect(r.outpoint).toBe(`${'ab'.repeat(32)}.0`);
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe('x-post-1234567890');
    expect(writes[0].options).toMatchObject({ protocolID: [1, 'authsig'] });
    const v = decodeProofValue(writes[0].value)!;
    expect(Object.keys(JSON.parse(writes[0].value)).slice(0, 6)).toEqual([
      'signature',
      'publicKey',
      'signedAt',
      'protocol',
      'content',
      'contentHash',
    ]);
    expect(v.protocol).toBe('authsig-v1');
    expect(v.contentHash).toBe(sha256Hex(content));
    expect(v.signedAt).toBe('2026-11-01T12:00:00.000Z');
    const p = await verifyEntry({
      key: writes[0].key,
      value: writes[0].value,
      controller: r.publicKey,
      protocolID: [1, 'authsig'],
      token: { txid: 'ab'.repeat(32), outputIndex: 0 },
    });
    expect(p).toMatchObject({ content, publicKey: r.publicKey, source: 'bwalletx', claimedName: '$alice' });
  });

  test('selected text: the key is the content hash', async () => {
    const { store, writes } = fakeStore();
    const content = 'Any text on any page';
    const r = await signProof(wallet, store, { key: sha256Hex(content), content });
    const p = await verifyEntry({
      key: writes[0].key,
      value: writes[0].value,
      controller: r.publicKey,
      protocolID: [1, 'authsig'],
    });
    expect(p?.content).toBe(content);
    expect(p?.source).toBe('authsig'); // no bWalletX extras on this one
  });

  test('refuses a key that does not fit the content', async () => {
    const { store } = fakeStore();
    await expect(signProof(wallet, store, { key: 'f'.repeat(64), content: 'x' })).rejects.toThrow('Bad proof key');
    await expect(signProof(wallet, store, { key: 'whatever', content: 'x' })).rejects.toThrow('Bad proof key');
    await expect(signProof(wallet, store, { key: 'x-post-1', content: '' })).rejects.toThrow('Nothing to sign');
  });

  test('a content-hash record without content verifies against the page text that hashes to its key', async () => {
    const { store, writes } = fakeStore();
    const content = 'A paragraph long enough to be hashed by AuthSig';
    const r = await signProof(wallet, store, { key: sha256Hex(content), content });
    const v = JSON.parse(writes[0].value);
    delete v.content;
    delete v.contentHash;
    const entry: KvEntry = {
      key: writes[0].key,
      value: JSON.stringify(v),
      controller: r.publicKey,
      protocolID: [1, 'authsig'],
    };
    expect(await verifyEntry(entry)).toBeNull();
    expect(await verifyEntry(entry, 'some other text')).toBeNull();
    expect((await verifyEntry(entry, content))?.content).toBe(content);
  });
});

describe('estimateProofSats', () => {
  test('grows with the value and the fee rate, includes the 1-sat token', () => {
    const small = estimateProofSats('x-post-1', 'v'.repeat(300), 100);
    const big = estimateProofSats('x-post-1', 'v'.repeat(3000), 100);
    expect(small).toBeGreaterThan(1);
    expect(big).toBeGreaterThan(small);
    expect(estimateProofSats('k', 'v', 1000)).toBeGreaterThan(estimateProofSats('k', 'v', 100));
    expect(estimateProofSats('k', 'v', Number.NaN)).toBe(estimateProofSats('k', 'v', 100));
  });
});
