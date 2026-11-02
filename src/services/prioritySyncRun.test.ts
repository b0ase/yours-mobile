import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { outputsPaying } from './prioritySyncRun';

const ours = PrivateKey.fromRandom().toPublicKey().toAddress();
const theirs = PrivateKey.fromRandom().toPublicKey().toAddress();
const hash = (a: string) => Utils.toHex(Utils.fromBase58Check(a).data as number[]);

/** A 1sat inscription: an envelope with a big body, then the owner's P2PKH. */
const inscription = (address: string, bytes: number) => {
  const p2pkh = new P2PKH().lock(address).toHex();
  const body = 'ab'.repeat(bytes);
  const len = bytes.toString(16).padStart(8, '0').match(/../g)!.reverse().join('');
  return LockingScript.fromHex(
    `0063036f726451186170706c69636174696f6e2f6f637465742d73747265616d004e${len}${body}68${p2pkh}`,
  );
};

const tx = () => {
  const t = new Transaction();
  t.addInput({
    sourceTXID: 'cd'.repeat(32),
    sourceOutputIndex: 3,
    unlockingScript: LockingScript.fromHex('00'),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: new P2PKH().lock(theirs), satoshis: 5000 });
  t.addOutput({ lockingScript: inscription(ours, 300_000), satoshis: 1 });
  t.addOutput({ lockingScript: new P2PKH().lock(ours), satoshis: 2_500_000_000 });
  return t;
};

describe('outputsPaying: classify a transaction from its raw bytes', () => {
  test('finds bare and inscribed P2PKH outputs to our addresses, with their satoshis', () => {
    const raw = Uint8Array.from(tx().toBinary());
    expect(outputsPaying(raw, new Set([hash(ours)]))).toEqual([1, 2_500_000_000]);
    expect(outputsPaying(raw, new Set([hash(theirs)]))).toEqual([5000]);
    expect(outputsPaying(raw, new Set([hash(PrivateKey.fromRandom().toPublicKey().toAddress())]))).toEqual([]);
  });

  test('a truncated transaction is an error, never a silent "not ours"', () => {
    const raw = Uint8Array.from(tx().toBinary());
    expect(() => outputsPaying(raw.subarray(0, raw.length - 30), new Set([hash(ours)]))).toThrow();
  });
});

describe('allOneSat: indexer tags decide names without a download', () => {
  test('inscriptions, tokens and names are 1-sat items; an untagged or unknown output is not', async () => {
    const { allOneSat } = await import('./prioritySyncRun');
    expect(allOneSat([{ data: { insc: {} } }, { data: { bsv21: {}, insc: {} } }, { data: { opns: {} } }])).toBe(true);
    expect(allOneSat([{ data: { insc: {} } }, {}])).toBe(false);
    expect(allOneSat([{ data: { insc: {} } }, null])).toBe(false);
    expect(allOneSat([{ data: { map: {} } }])).toBe(false);
    expect(allOneSat([])).toBe(false);
  });
});

describe('coinOutputs: coins go straight into the wallet, no source transactions', () => {
  test('only plain P2PKH outputs over 1 sat to our keys, as deposit-basket insertions with their key', async () => {
    const { coinOutputs } = await import('./prioritySyncRun');
    const keyByHash = new Map([
      [hash(ours), { derivationPrefix: 'bWfaV', derivationSuffix: '7', protocolID: [1, 'onesat'] as [1, string] }],
    ]);
    const t = tx(); // vout 0 theirs 5000, vout 1 our inscription 1 sat, vout 2 ours 2.5 BSV
    t.addOutput({ lockingScript: new P2PKH().lock(ours), satoshis: 1 });
    const r = coinOutputs(t, keyByHash, 'abc');
    expect(r.satoshis).toBe(2_500_000_000);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0].outputIndex).toBe(2);
    expect(r.outputs[0].protocol).toBe('basket insertion');
    expect(r.outputs[0].insertionRemittance?.tags).toEqual(['id:abc_2']);
    expect(JSON.parse(r.outputs[0].insertionRemittance!.customInstructions!)).toEqual({
      protocolID: [1, 'onesat'],
      keyID: 'bWfaV 7',
      counterparty: 'self',
    });
  });
});
