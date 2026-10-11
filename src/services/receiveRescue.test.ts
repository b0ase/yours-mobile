import { describe, expect, test } from 'bun:test';
import { Beef, P2PKH, PrivateKey, Spend, Transaction, type WalletProtocol } from '@bsv/sdk';
import { RESCUE_MIN_AGE_MS, RESCUE_MIN_SATS, p2pkhAddress, rescueStuckOutputs, type RescueDeps } from './receiveRescue';

const key = PrivateKey.fromRandom();
const address = key.toAddress();

/** A funding tx paying `sats` to our address at vout 0 (owner, 11 Oct 2026: one 25,432,350-sat output). */
const fundingTx = (sats: number) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sats });
  return tx;
};

const deps = (src: Transaction, over: Partial<RescueDeps> = {}) => {
  const calls = { broadcast: [] as Transaction[], internalize: 0 };
  const d: RescueDeps = {
    getRawTx: async () => src.toBinary(),
    getBeef: async () => {
      const b = new Beef();
      b.mergeTransaction(src);
      return b.toBinary();
    },
    isConfirmed: async () => true,
    derivationFor: async (a) =>
      a === address ? { address: a, derivationPrefix: '1sat', derivationSuffix: '0' } : null,
    // Sign with the test key (the wallet signs with the derived deposit key in the app).
    signInput: async (tx, i) => {
      const unlock = new P2PKH().unlock(key);
      tx.inputs[i].unlockingScriptTemplate = unlock;
      const s = await unlock.sign(tx, i);
      tx.inputs[i].unlockingScriptTemplate = undefined;
      return s.toHex();
    },
    broadcast: async (tx) => {
      calls.broadcast.push(tx);
    },
    internalize: async (beef) => {
      calls.internalize++;
      const b = Beef.fromBinary(beef);
      // The last tx in the BEEF is the new one internalizeBeef treats as the main transaction.
      expect(b.txs[b.txs.length - 1].txid).toBe(calls.broadcast[0].id('hex'));
      return 1;
    },
    protocolID: [2, '1sat'] as WalletProtocol,
    feeRate: 100,
    firstSeen: () => 0,
    now: () => 1_000_000_000,
    log: () => undefined,
    ...over,
  };
  return { d, calls };
};

describe('rescue money stuck at our own receive address', () => {
  test('a stuck output is spent back to the same address in a fresh tx and credited', async () => {
    const src = fundingTx(25_432_350);
    const { d, calls } = deps(src);
    const out = await rescueStuckOutputs([{ outpoint: `${src.id('hex')}.0`, satoshis: 25_432_350 }], d);
    expect(out).toHaveLength(1);
    expect(calls.broadcast).toHaveLength(1);
    expect(calls.internalize).toBe(1);
    const tx = calls.broadcast[0];
    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toHaveLength(1);
    expect(p2pkhAddress(tx, 0)).toBe(address);
    const kept = tx.outputs[0].satoshis ?? 0;
    expect(kept).toBeLessThan(25_432_350);
    expect(kept).toBeGreaterThan(25_432_350 - 1000); // fee is tiny
    // The unlocking script really spends the source output.
    const spend = new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 25_432_350,
      lockingScript: src.outputs[0].lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript!,
      inputSequence: tx.inputs[0].sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    });
    expect(spend.validate()).toBe(true);
  });

  test('ordinals, dust and other people’s addresses are never touched', async () => {
    const one = fundingTx(1);
    const r1 = deps(one);
    expect(await rescueStuckOutputs([{ outpoint: `${one.id('hex')}.0`, satoshis: 1 }], r1.d)).toHaveLength(0);
    expect(r1.calls.broadcast).toHaveLength(0);

    const small = fundingTx(RESCUE_MIN_SATS - 1);
    const r2 = deps(small);
    expect(
      await rescueStuckOutputs([{ outpoint: `${small.id('hex')}.0`, satoshis: RESCUE_MIN_SATS - 1 }], r2.d),
    ).toHaveLength(0);

    const theirs = fundingTx(50_000);
    const r3 = deps(theirs, { derivationFor: async () => null });
    expect(await rescueStuckOutputs([{ outpoint: `${theirs.id('hex')}.0`, satoshis: 50_000 }], r3.d)).toHaveLength(0);
    expect(r3.calls.broadcast).toHaveLength(0);
  });

  test('an unconfirmed payment is left to the normal sync until it has been missing a while', async () => {
    const src = fundingTx(50_000);
    const op = `${src.id('hex')}.0`;
    const fresh = deps(src, { isConfirmed: async () => false, firstSeen: () => 1_000_000_000 - 60_000 });
    expect(await rescueStuckOutputs([{ outpoint: op, satoshis: 50_000 }], fresh.d)).toHaveLength(0);
    const old = deps(src, { isConfirmed: async () => false, firstSeen: () => 1_000_000_000 - RESCUE_MIN_AGE_MS - 1 });
    expect(await rescueStuckOutputs([{ outpoint: op, satoshis: 50_000 }], old.d)).toHaveLength(1);
  });

  test('a refused broadcast is reported, never thrown, and nothing is credited', async () => {
    const src = fundingTx(50_000);
    const { d, calls } = deps(src, {
      broadcast: async () => {
        throw new Error('refused');
      },
    });
    const orig = console.error;
    console.error = () => undefined;
    try {
      expect(await rescueStuckOutputs([{ outpoint: `${src.id('hex')}_0`, satoshis: 50_000 }], d)).toHaveLength(0);
    } finally {
      console.error = orig;
    }
    expect(calls.internalize).toBe(0);
  });
});
