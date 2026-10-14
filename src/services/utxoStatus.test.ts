import { describe, expect, test } from 'bun:test';
import { fixUtxoStatus, parseOutpoint, utxoStatusFromTxo } from './utxoStatus';

const T = '9f66943be1ed8157b6935c5ae19b6508cbc4a17779a5e5f3f42bf7034a08309b';

describe('outpoints with a dot or an underscore', () => {
  test('parseOutpoint', () => {
    expect(parseOutpoint(`${T}.0`)).toEqual({ txid: T, vout: 0 });
    expect(parseOutpoint(`${T}_12`)).toEqual({ txid: T, vout: 12 });
    expect(parseOutpoint(`${T.toUpperCase()}.1`)).toEqual({ txid: T, vout: 1 });
    expect(parseOutpoint(`${T}`)).toBeNull();
    expect(parseOutpoint(`${T}.x`)).toBeNull();
    expect(parseOutpoint(undefined)).toBeNull();
  });
});

describe('getUtxoStatus from api.1sat.app', () => {
  // What api.1sat.app/1sat/txo/<outpoint> answered on 14 Oct 2026 (read-only GETs).
  const unspent = async () => ({ outpoint: `${T}.0`, score: 0 });
  const spent = async () => ({ outpoint: `${T}.0`, score: 0, spend: 'ab'.repeat(32) });

  test('unspent, dot outpoint, no satoshis: success, isUtxo, no partial detail', async () => {
    for (const asked of [`${T}.0`, `${T}_0`])
      expect(await utxoStatusFromTxo(unspent, asked)).toEqual({
        name: '1sat-api',
        status: 'success',
        isUtxo: true,
        details: [],
      });
  });

  test('with satoshis: detail included', async () => {
    const r = await utxoStatusFromTxo(async () => ({ outpoint: `${T}_0`, satoshis: 58_614_198_569 }), `${T}.0`);
    expect(r.details).toEqual([{ txid: T, index: 0, satoshis: 58_614_198_569 }]);
  });

  test('spent', async () => {
    expect((await utxoStatusFromTxo(spent, `${T}.0`)).isUtxo).toBe(false);
  });

  test('not found / error / another outpoint: inconclusive, never "spent"', async () => {
    const nf = await utxoStatusFromTxo(async () => {
      throw new Error('404');
    }, `${T}.0`);
    expect(nf.status).toBe('error');
    expect(nf.isUtxo).toBeUndefined();
    expect((await utxoStatusFromTxo(async () => ({ outpoint: `${T}.1` }), `${T}.0`)).status).toBe('error');
    expect((await utxoStatusFromTxo(unspent, undefined)).status).toBe('error');
  });

  test('fixUtxoStatus installs over a services object with a txo client', async () => {
    const asked: string[] = [];
    const svc: Record<string, unknown> = {
      txo: {
        get: async (o: string) => {
          asked.push(o);
          return { outpoint: o.replace('_', '.') };
        },
      },
    };
    expect(fixUtxoStatus(svc)).toBe(true);
    const r = await (svc.getUtxoStatus as (h: string, f: unknown, o: string) => Promise<{ isUtxo: boolean }>)(
      'h',
      undefined,
      `${T}.3`,
    );
    expect(r.isUtxo).toBe(true);
    expect(asked).toEqual([`${T}_3`]);
    expect(fixUtxoStatus({})).toBe(false);
  });
});
