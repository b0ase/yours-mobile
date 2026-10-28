import { describe, expect, test } from 'bun:test';
import * as rf from './recoverFailed';

/** b-Aware 28 Oct 2026 (hilmiadi677, H-2): abortAction by BRC-100 reference skipped the on-chain guard. */
describe('abort guard checks the transaction a reference names', () => {
  const TXID = 'ab'.repeat(32);
  const guard = (rf as Record<string, unknown>).abortTargetKnownOnChain as
    | ((
        ref: string,
        deps: {
          txidForReference: (r: string) => Promise<string | null>;
          knownOnChain: (t: string) => Promise<boolean>;
        },
      ) => Promise<boolean>)
    | undefined;

  test('a reference whose transaction is on chain is not aborted', async () => {
    expect(typeof guard).toBe('function');
    const seen: string[] = [];
    const known = await guard!('cmVmZXJlbmNlLTE=', {
      txidForReference: async () => TXID,
      knownOnChain: async (t) => (seen.push(t), true),
    });
    expect(known).toBe(true);
    expect(seen).toEqual([TXID]);
  });

  test('a failed storage lookup fails closed', async () => {
    expect(
      await guard!('cmVmZXJlbmNlLTE=', {
        txidForReference: async () => {
          throw new Error('storage down');
        },
        knownOnChain: async () => false,
      }),
    ).toBe(true);
  });

  test('an unsigned action (no txid yet) may be aborted; a txid is checked directly', async () => {
    expect(await guard!('cmVm', { txidForReference: async () => null, knownOnChain: async () => true })).toBe(false);
    expect(await guard!(TXID, { txidForReference: async () => null, knownOnChain: async (t) => t === TXID })).toBe(
      true,
    );
  });

  test('the background abort handler uses it', async () => {
    const src = await Bun.file(new URL('../background.ts', import.meta.url)).text();
    const handler = src.slice(src.indexOf('const processCWIAbortAction'), src.indexOf('w.abortAction(message.params'));
    expect(handler).toContain('abortTargetKnownOnChain(');
  });
});
