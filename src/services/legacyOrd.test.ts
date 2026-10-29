import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature } from '@bsv/sdk';
import {
  installLegacySigner,
  installLegacyOrdSigner,
  LEGACY_PAY_KEY_ID,
  LEGACY_PAY_PROTOCOL,
  legacyPayKey,
  takeInLegacyOrd,
  watchedLegacyPayAddress,
  LEGACY_ORD_KEY_ID,
  LEGACY_ORD_PROTOCOL,
  legacyOrdKey,
  legacyOrdVisible,
  syncLegacyOrd,
  watchedLegacyOrdAddress,
} from './legacyOrd';
import { isReservedProtocol, reservedProtocolRefusal } from './reservedProtocols';

const key = PrivateKey.fromRandom();
const addr = key.toPublicKey().toAddress();

const fakeWallet = () => {
  const calls: string[] = [];
  return {
    calls,
    getPublicKey: async () => {
      calls.push('getPublicKey');
      return { publicKey: 'inner' };
    },
    createSignature: async () => {
      calls.push('createSignature');
      return { signature: [1] };
    },
  };
};

describe('legacyOrdKey', () => {
  test('returns the key only when it matches the address', () => {
    expect(legacyOrdKey(key.toWif(), addr)?.toWif()).toBe(key.toWif());
    expect(legacyOrdKey(key.toWif(), PrivateKey.fromRandom().toPublicKey().toAddress())).toBeUndefined();
    expect(legacyOrdKey(undefined, addr)).toBeUndefined();
    expect(legacyOrdKey('not a wif', addr)).toBeUndefined();
  });
});

describe('installLegacyOrdSigner', () => {
  test('signs the legacy protocol with the ord key, passes everything else through', async () => {
    const w = fakeWallet();
    const undo = installLegacyOrdSigner(w as never, key);
    expect(watchedLegacyOrdAddress()).toBe(addr);
    const args = { protocolID: LEGACY_ORD_PROTOCOL, keyID: LEGACY_ORD_KEY_ID, counterparty: 'self' as const };
    const { publicKey } = await w.getPublicKey({ ...args, forSelf: true } as never);
    expect(PublicKey.fromString(publicKey).toAddress()).toBe(addr);
    const hash = Hash.sha256([1, 2, 3]);
    const { signature } = await w.createSignature({ ...args, hashToDirectlySign: hash } as never);
    expect(ECDSA.verify(new BigNumber(hash), Signature.fromDER(signature), key.toPublicKey())).toBe(true);
    // Other protocols / keyIDs / counterparties: the wallet's own derivation.
    await w.getPublicKey({ protocolID: [2, 'other'], keyID: 'ord' } as never);
    await w.createSignature({ ...args, keyID: '1sat 0', hashToDirectlySign: hash } as never);
    await w.createSignature({ ...args, counterparty: 'anyone', hashToDirectlySign: hash } as never);
    expect(w.calls).toEqual(['getPublicKey', 'createSignature', 'createSignature']);
    undo();
    expect(watchedLegacyOrdAddress()).toBeUndefined();
  });

  test('the protocol is refused to outside apps', () => {
    expect(isReservedProtocol(LEGACY_ORD_PROTOCOL)).toBe(true);
    expect(reservedProtocolRefusal('createSignature', { protocolID: LEGACY_ORD_PROTOCOL, keyID: 'ord' })).toContain(
      'reserved',
    );
  });
});

describe('syncLegacyOrd', () => {
  const T1 = 'a'.repeat(64);
  const T2 = 'b'.repeat(64);
  const T3 = 'c'.repeat(64);
  test('takes in unheld origin ordinals per tx, with the legacy derivation', async () => {
    const seen: { txid: string; outputs: unknown }[] = [];
    const r = await syncLegacyOrd({
      address: addr,
      chain: 'main',
      services: { beef: { getBeef: async (t: string) => [t.charCodeAt(0)] } } as never,
      wallet: {
        listOutputs: async () => ({ totalOutputs: 1, outputs: [{ outpoint: `${T3}.0` }] }),
        internalizeAction: async () => ({ accepted: true }),
      } as never,
      scan: (async () => ({
        ordinals: [
          { outpoint: `${T1}_0`, satoshis: 1, origin: 'o1' },
          { outpoint: `${T1}_2`, satoshis: 1, origin: 'o2' },
          { outpoint: `${T2}_1`, satoshis: 1 }, // no origin
          { outpoint: `${T3}_0`, satoshis: 1, origin: 'o3' }, // already held
        ],
      })) as never,
      internalize: (async (o: { beef: number[]; outputs: unknown[] }) => {
        seen.push({ txid: String.fromCharCode(o.beef[0]), outputs: o.outputs });
        return { txid: '', internalized: o.outputs.length };
      }) as never,
    });
    expect(r).toEqual({ added: 2, failed: 0 });
    expect(seen).toEqual([
      {
        txid: 'a',
        outputs: [0, 2].map((outputIndex) => ({
          outputIndex,
          protocolID: LEGACY_ORD_PROTOCOL,
          keyID: 'ord',
          counterparty: 'self',
        })),
      },
    ]);
  });
});

describe('legacyOrdVisible (quarantine wins)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const legacy = new Set([`${A}_0`, `${B}_1`]);
  test('a legacy NFT shows only once kept; other NFTs always show', () => {
    expect(legacyOrdVisible(`${'c'.repeat(64)}.0`, legacy, [])).toBe(true);
    expect(legacyOrdVisible(`${A}.0`, legacy, [])).toBe(false);
    expect(legacyOrdVisible(`${A}.0`, legacy, [{ txid: A, outpoint: `${A}_0` }])).toBe(true);
    expect(legacyOrdVisible(`${B}.1`, legacy, [{ txid: B }])).toBe(true);
    expect(legacyOrdVisible(`${B}.1`, legacy, [{ txid: A, outpoint: `${A}_0` }])).toBe(false);
  });
});

describe('legacy pay key (walletWif)', () => {
  const pay = PrivateKey.fromRandom();
  const payAddr = pay.toPublicKey().toAddress();
  test('signs the pay protocol with the pay key and the ord protocol with the ord key', async () => {
    const w = fakeWallet();
    const undo = installLegacySigner(w as never, { ord: key, pay });
    expect(watchedLegacyPayAddress()).toBe(payAddr);
    const hash = Hash.sha256([9]);
    const args = { protocolID: LEGACY_PAY_PROTOCOL, keyID: LEGACY_PAY_KEY_ID, counterparty: 'self' as const };
    const { publicKey } = await w.getPublicKey({ ...args, forSelf: true } as never);
    expect(PublicKey.fromString(publicKey).toAddress()).toBe(payAddr);
    const { signature } = await w.createSignature({ ...args, hashToDirectlySign: hash } as never);
    expect(ECDSA.verify(new BigNumber(hash), Signature.fromDER(signature), pay.toPublicKey())).toBe(true);
    // Plain BSV at the ord address is filed under keyID 'legacy ord': the ord key signs it.
    const o = await w.getPublicKey({ protocolID: LEGACY_ORD_PROTOCOL, keyID: 'legacy ord' } as never);
    expect(PublicKey.fromString(o.publicKey).toAddress()).toBe(addr);
    // The pay protocol never answers the ord keyID, and the reverse.
    await w.getPublicKey({ protocolID: LEGACY_PAY_PROTOCOL, keyID: 'ord' } as never);
    await w.getPublicKey({ protocolID: LEGACY_ORD_PROTOCOL, keyID: LEGACY_PAY_KEY_ID } as never);
    expect(w.calls).toEqual(['getPublicKey', 'getPublicKey']);
    undo();
    expect(watchedLegacyPayAddress()).toBeUndefined();
  });

  test('the pay protocol is refused to outside apps', () => {
    expect(isReservedProtocol(LEGACY_PAY_PROTOCOL)).toBe(true);
  });

  test('no WIF (passkey / seedless) or a mismatch: no key, nothing watched, nothing taken in', async () => {
    expect(legacyPayKey(undefined, payAddr)).toBeUndefined();
    expect(legacyPayKey(pay.toWif(), addr)).toBeUndefined();
    expect(watchedLegacyPayAddress()).toBeUndefined();
    let scanned = 0;
    const r = await takeInLegacyOrd({
      wallet: {},
      services: {
        owner: {
          getTxos: () => {
            scanned++;
            return (async function* () {})();
          },
        },
      } as never,
    });
    expect(r).toEqual({ added: 0, failed: 0 });
    expect(scanned).toBe(0);
  });
});

describe('syncLegacyOrd: tokens, names and plain BSV', () => {
  const T1 = 'd'.repeat(64);
  const T2 = 'e'.repeat(64);
  const T3 = 'f'.repeat(64);
  const run = (kind: 'ord' | 'pay', held: string[] = []) => {
    const seen: { txid: string; outputs: unknown[] }[] = [];
    const baskets: string[] = [];
    return syncLegacyOrd({
      address: addr,
      kind,
      chain: 'main',
      services: { beef: { getBeef: async (t: string) => [t.charCodeAt(0)] } } as never,
      wallet: {
        listOutputs: async (a: { basket: string }) => {
          baskets.push(a.basket);
          return { totalOutputs: held.length, outputs: held.map((outpoint) => ({ outpoint })) };
        },
        internalizeAction: async () => ({ accepted: true }),
      } as never,
      scan: (async () => ({
        ordinals: [{ outpoint: `${T1}_0`, satoshis: 1, origin: 'o1' }],
        opnsNames: [{ outpoint: `${T1}_1`, satoshis: 1 }],
        bsv21Tokens: [{ tokenId: 'tok_0', outputs: [{ outpoint: `${T2}_0`, satoshis: 1 }] }],
        funding: [
          { outpoint: `${T3}_1`, satoshis: 5000 },
          { outpoint: `${T3}_2`, satoshis: 1 }, // not plain BSV
        ],
        runJigs: [{ outpoint: `${T3}_3`, satoshis: 1 }],
        locked: [{ outpoint: `${T3}_4`, satoshis: 900 }],
      })) as never,
      internalize: (async (o: { beef: number[]; outputs: unknown[] }) => {
        seen.push({ txid: String.fromCharCode(o.beef[0]), outputs: o.outputs });
        return { txid: '', internalized: o.outputs.length };
      }) as never,
    }).then((r) => ({ r, seen, baskets }));
  };
  const legacy = (outputIndex: number, suffix: string, protocolID = LEGACY_ORD_PROTOCOL) => ({
    outputIndex,
    protocolID,
    derivationPrefix: 'legacy',
    derivationSuffix: suffix,
    counterparty: 'self',
  });

  test('ord address: NFT keeps keyID ord; name, BSV-21 and BSV are taken in; jigs and locks never', async () => {
    const { r, seen, baskets } = await run('ord');
    expect(r).toEqual({ added: 4, failed: 0 });
    expect(seen).toEqual([
      {
        txid: 'd',
        outputs: [
          { outputIndex: 0, protocolID: LEGACY_ORD_PROTOCOL, keyID: 'ord', counterparty: 'self' },
          // The OpNS name, like any ordinal at the ord address.
          { outputIndex: 1, protocolID: LEGACY_ORD_PROTOCOL, keyID: 'ord', counterparty: 'self' },
        ],
      },
      { txid: 'e', outputs: [legacy(0, 'ord')] },
      { txid: 'f', outputs: [legacy(1, 'ord')] },
    ]);
    // Held anywhere (deposit, funding, tokens, names) counts as held.
    expect(baskets).toEqual(expect.arrayContaining(['1sat', 'bsv21', 'opns', '1sat-deposit', 'default']));
  });

  test('pay address: everything under the pay protocol', async () => {
    const { seen } = await run('pay');
    expect(seen.map((s) => s.outputs)).toEqual([
      [legacy(0, 'pay', LEGACY_PAY_PROTOCOL), legacy(1, 'pay', LEGACY_PAY_PROTOCOL)],
      [legacy(0, 'pay', LEGACY_PAY_PROTOCOL)],
      [legacy(1, 'pay', LEGACY_PAY_PROTOCOL)],
    ]);
  });

  test('outputs the wallet already holds are not taken in again (no double count)', async () => {
    const { r, seen } = await run('ord', [`${T2}.0`, `${T3}.1`, `${T1}.1`]);
    expect(r).toEqual({ added: 1, failed: 0 });
    expect(seen.map((s) => s.txid)).toEqual(['d']);
  });

  test('BSV-21 rows get their bsv21:<id> tag', async () => {
    let filed: { outputs: { insertionRemittance?: { tags?: string[] } }[] } | undefined;
    await syncLegacyOrd({
      address: addr,
      chain: 'main',
      services: { beef: { getBeef: async () => [1] } } as never,
      wallet: {
        listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
        internalizeAction: async (a: typeof filed) => {
          filed = a;
          return { accepted: true };
        },
      } as never,
      scan: (async () => ({ bsv21Tokens: [{ tokenId: 'tok_0', outputs: [{ outpoint: `${T2}_0` }] }] })) as never,
      internalize: (async (o: { wallet: { internalizeAction: (a: unknown) => Promise<unknown> } }) => {
        await o.wallet.internalizeAction({
          tx: [],
          description: 'Received 1 TEST',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: { basket: 'bsv21', tags: ['id:x_0'], customInstructions: '{"id":"tok_0"}' },
            },
          ],
        });
        return { txid: '', internalized: 1 };
      }) as never,
    });
    expect(filed?.outputs[0].insertionRemittance?.tags).toEqual(['id:x_0', 'bsv21:tok_0']);
  });
});
