import { describe, expect, test } from 'bun:test';
import { PrivateKey, KeyDeriver } from '@bsv/sdk';
import { recoverPaymentByTxid, txidRecoverySummary, type TxidRecoverDeps } from './recoverByTxid';

const TXID = 'd2be946fa878a3338babd5b19ec22c44f3f02b19cb17ea43ae7576672df6875f';
const never = <T>() => new Promise<T>(() => undefined);

const base = (over: Partial<TxidRecoverDeps>): TxidRecoverDeps => ({
  keyDeriver: new KeyDeriver(PrivateKey.fromRandom()),
  getRawTx: async () => {
    throw new Error('network must not be called');
  },
  getMerklePath: async () => {
    throw new Error('network must not be called');
  },
  isUnspent: async () => undefined,
  findDerivations: async () => {
    throw new Error('stores must not be searched');
  },
  activeRows: async () => ({ outputs: [] }),
  internalize: async () => undefined,
  repairRows: async () => undefined,
  log: () => undefined,
  ...over,
});

describe('recover by txid: fast path and timeouts (owner, 15 Oct 2026: "Checking…" forever)', () => {
  test('a payment already in the wallet answers from local records, no network or remote calls', async () => {
    const steps: string[] = [];
    const t0 = Date.now();
    const r = await recoverPaymentByTxid(
      TXID,
      base({
        localRecord: async () => ({ status: 'completed', satoshis: 12_345, createdAt: Date.UTC(2026, 9, 14) }),
        progress: (s) => steps.push(s),
      }),
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.result).toBe('already');
    expect(txidRecoverySummary(r)).toMatch(/^Checked: d2be946f… is in your wallet \(0\.00012345 BSV, /);
    expect(steps).toEqual(['Checking your wallet…']);
  });

  test('a hanging raw-tx fetch ends with a plain error naming the step', async () => {
    const r = await recoverPaymentByTxid(
      TXID,
      base({ localRecord: async () => undefined, getRawTx: () => never(), stepTimeoutMs: 50 }),
    );
    expect(r.result).toBe('error');
    expect(txidRecoverySummary(r)).toMatch(/Couldn’t fetch the transaction from the network after 0 s/);
  });

  test('a hanging local read times out too', async () => {
    const r = await recoverPaymentByTxid(TXID, base({ localRecord: () => never(), stepTimeoutMs: 50 }));
    expect(r.result).toBe('error');
    expect(r.error).toMatch(/this device’s wallet records/);
  });

  test('the whole run is capped', async () => {
    const r = await recoverPaymentByTxid(
      TXID,
      base({ localRecord: async () => undefined, getRawTx: () => never(), stepTimeoutMs: 10_000, runTimeoutMs: 60 }),
    );
    expect(r.result).toBe('error');
    expect(r.error).toMatch(/longer than 0 s; nothing was changed/);
  });

  test('an unreachable 1Sat backup is named when nothing else matched', async () => {
    const { Transaction, P2PKH, MerklePath } = await import('@bsv/sdk');
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1000 });
    const id = tx.id('hex');
    const r = await recoverPaymentByTxid(
      id,
      base({
        localRecord: async () => undefined,
        getRawTx: async () => tx.toBinary(),
        getMerklePath: async () => new MerklePath(1, [[{ offset: 0, hash: id, txid: true }]]),
        findDerivations: async () => ({ derivations: [], unreachable: ['the 1Sat backup (wallet.1sat.app)'] }),
      }),
    );
    expect(r.result).toBe('error');
    expect(txidRecoverySummary(r)).toMatch(/Couldn’t reach the 1Sat backup \(wallet\.1sat\.app\); nothing was changed/);
  });
});
