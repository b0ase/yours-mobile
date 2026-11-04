import { describe, expect, test } from 'bun:test';
import { recheckRefusals, recheckResults } from './refusalRecheck';
import type { ChainLookup } from './unsentGuard';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const say =
  (m: Record<string, 'seen' | 'missing' | 'unclear'>): ChainLookup =>
  async (t) =>
    m[t] ?? 'unclear';
const refused = (txid: string) => ({
  name: '1sat-api',
  status: 'error',
  error: new Error('REJECTED'),
  txidResults: [{ txid, status: 'error', data: { txStatus: 'REJECTED' } }],
});

describe('a refusal is checked against the chain before the toolbox fails the tx (P0, 3 Nov 2026)', () => {
  test('the chain has it: success (e.g. 1sat-stack REJECTED a re-send of a mined tx as UTXO_SPENT)', async () => {
    const r = (await recheckResults([refused(A)], [say({ [A]: 'seen' })], () => undefined)) as {
      status: string;
      error?: unknown;
      txidResults: { status: string }[];
    }[];
    expect(r[0].txidResults[0].status).toBe('success');
    expect(r[0].status).toBe('success');
    expect(r[0].error).toBeUndefined();
  });

  test('every lookup says not found: the refusal stands', async () => {
    const r = (await recheckResults(
      [refused(A)],
      [say({ [A]: 'missing' }), say({ [A]: 'missing' })],
      () => undefined,
    )) as {
      txidResults: { status: string; serviceError?: boolean }[];
    }[];
    expect(r[0].txidResults[0]).toMatchObject({ status: 'error' });
    expect(r[0].txidResults[0].serviceError).toBeUndefined();
  });

  test('anything unclear: a service error (stays sending, retried; nothing released)', async () => {
    const r = (await recheckResults([refused(A)], [say({ [A]: 'missing' }), say({})], () => undefined)) as {
      txidResults: { status: string; serviceError?: boolean }[];
    }[];
    expect(r[0].txidResults[0]).toMatchObject({ status: 'error', serviceError: true });
  });

  test('double spends and service errors pass through untouched; the chain is not asked', async () => {
    let asked = 0;
    const counting: ChainLookup = async () => (asked++, 'seen');
    const ds = { status: 'error', txidResults: [{ txid: A, status: 'error', doubleSpend: true }] };
    const se = { status: 'error', txidResults: [{ txid: B, status: 'error', serviceError: true }] };
    await recheckResults([ds, se], [counting], () => undefined);
    expect(asked).toBe(0);
    expect(ds.txidResults[0]).toEqual({ txid: A, status: 'error', doubleSpend: true });
  });

  test('recheckRefusals wraps postBeef once', async () => {
    const svc = { postBeef: async (_b: unknown, txids: string[]) => txids.map(refused) };
    expect(
      recheckRefusals(
        svc,
        () => [say({ [A]: 'seen' })],
        () => undefined,
      ),
    ).toBe(true);
    expect(
      recheckRefusals(
        svc,
        () => [say({ [A]: 'seen' })],
        () => undefined,
      ),
    ).toBe(true);
    const out = (await svc.postBeef(null, [A])) as { txidResults: { status: string }[] }[];
    expect(out[0].txidResults[0].status).toBe('success');
    expect(recheckRefusals({}, () => [])).toBe(false);
  });
});
