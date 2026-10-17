import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import type { OneSatServices } from '@1sat/client';
import type { IndexedOutput } from '@1sat/types';
import { isRunJig, isRunTx, RUN_JIG_SATS } from './runGuard';
import { scanAddress } from './scanner';

const addr = new PrivateKey(3).toPublicKey().toAddress();
/** A source tx: a Run payload in vout0 (RelayX shape) or a plain payment. */
const sourceTx = (run: boolean, n: number) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: n.toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  if (run)
    tx.addOutput({
      lockingScript: new Script()
        .writeOpCode(0)
        .writeOpCode(0x6a)
        .writeBin(Utils.toArray('run', 'utf8'))
        .writeBin([5])
        .writeBin(Utils.toArray('relayx.io', 'utf8')),
      satoshis: 0,
    });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 546 });
  return tx;
};

const txs = new Map<string, Transaction>();
const out = (sats: number, run: boolean | 'unreadable', n: number, events: string[] = []): IndexedOutput => {
  const tx = sourceTx(run === true, n);
  const id = tx.id('hex');
  if (run !== 'unreadable') txs.set(id, tx);
  return { outpoint: `${id}_${run === true ? 1 : 0}`, satoshis: sats, events } as unknown as IndexedOutput;
};

// A restored RelayX owner address: jigs at 273, 546 and 1 sat; plain coins of the same sizes; one unreadable source.
const RELAYX = [
  out(273, true, 1),
  out(546, true, 2),
  out(1, true, 3),
  out(546, false, 4),
  out(1, false, 5),
  out(5000, false, 6),
  out(546, 'unreadable', 7),
  out(900, false, 8, ['type:run']),
];

const services = {
  owner: {
    async *getTxos() {
      yield { type: 'done' };
    },
  },
  txo: { search: async () => RELAYX },
  beef: {
    getRawTx: async (txid: string) => {
      const tx = txs.get(txid);
      if (!tx) throw new Error('not found');
      return tx.toBinary();
    },
  },
} as unknown as OneSatServices;

describe('Run NFT guard (RelayX collections)', () => {
  test('cheap rule: 273 sats or a Run tag', () => {
    expect(RUN_JIG_SATS).toBe(273);
    expect(isRunJig({ satoshis: 273 })).toBe(true);
    expect(isRunJig({ satoshis: 900, events: ['type:run'] })).toBe(true);
    expect(isRunJig({ satoshis: 5000 })).toBe(false);
    expect(isRunJig({ satoshis: 900, events: ['type:runner-up'] })).toBe(false);
  });

  test('isRunTx spots the RelayX payload', () => {
    expect(isRunTx(sourceTx(true, 9).toBinary())).toBe(true);
    expect(isRunTx(sourceTx(false, 9).toBinary())).toBe(false);
  });

  test('no jig (1, 273 or 546 sats) or unreadable dust reaches funding or ordinals', async () => {
    const a = await scanAddress(services, '1B6Pjhoi1uD8dqDjczSaGXs4hBSQGQjh2');
    expect(a.runJigs.map((o) => o.satoshis).sort((x, y) => x - y)).toEqual([1, 273, 546, 546, 900]);
    expect(a.funding.map((o) => o.satoshis).sort((x, y) => x - y)).toEqual([546, 5000]);
    expect(a.totalBsv).toBe(5546);
    expect(a.ordinals.length).toBe(1);
  });
});
