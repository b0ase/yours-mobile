import { describe, expect, test } from 'bun:test';
import type { OneSatServices } from '@1sat/client';
import type { IndexedOutput } from '@1sat/types';
import { isRunJig, RUN_JIG_SATS } from './runGuard';
import { scanAddress } from './scanner';

const out = (n: number, sats: number, events: string[] = []): IndexedOutput =>
  ({ outpoint: `${String(n).padStart(64, '0')}_0`, satoshis: sats, events }) as unknown as IndexedOutput;

// A restored RelayX owner address: Run jigs (273 sats), 1-sat ordinals and one ordinary coin.
const RELAYX = [out(1, 273), out(2, 273), out(3, 1), out(4, 5000), out(5, 900, ['type:run'])];

const services = {
  owner: {
    async *getTxos() {
      yield { type: 'done' };
    },
  },
  txo: { search: async () => RELAYX },
} as unknown as OneSatServices;

describe('Run NFT guard (RelayX collections)', () => {
  test('273-sat outputs and Run-tagged outputs are Run jigs; ordinary coins are not', () => {
    expect(RUN_JIG_SATS).toBe(273);
    expect(isRunJig({ satoshis: 273 })).toBe(true);
    expect(isRunJig({ satoshis: 900, events: ['type:run'] })).toBe(true);
    expect(isRunJig({ satoshis: 5000 })).toBe(false);
    expect(isRunJig({ satoshis: 1 })).toBe(false);
    expect(isRunJig({ satoshis: 900, events: ['type:runner-up'] })).toBe(false);
  });

  test('a scan never puts Run jigs in funding, so no sweep, fee or send-max can spend them', async () => {
    const a = await scanAddress(services, '1B6Pjhoi1uD8dqDjczSaGXs4hBSQGQjh2');
    expect(a.runJigs.map((o) => o.satoshis)).toEqual([273, 273, 900]);
    expect(a.funding.map((o) => o.satoshis)).toEqual([5000]);
    expect(a.totalBsv).toBe(5000);
    expect(a.ordinals.length).toBe(1);
  });
});
