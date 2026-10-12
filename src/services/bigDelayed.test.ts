import { describe, expect, test } from 'bun:test';
import {
  BIG_TX_BYTES,
  KICK_DELAYS_MS,
  createActionBytes,
  kickSendWaiting,
  pendingShape,
  shouldDelay,
  signActionBytes,
  withDelayedBroadcast,
} from './bigDelayed';

const TXID = 'ab'.repeat(32);
const hex = (bytes: number) => '00'.repeat(bytes);

describe('size threshold', () => {
  test('a small payment is never changed', () => {
    const args = { outputs: [{ lockingScript: hex(25), satoshis: 1000 }], options: { acceptDelayedBroadcast: false } };
    const bytes = createActionBytes(args);
    expect(bytes).toBeLessThan(BIG_TX_BYTES);
    expect(shouldDelay(bytes, args.options)).toBe(false);
  });

  test('exactly 1 MB stays inline; over 1 MB goes to the background sender', () => {
    expect(shouldDelay(BIG_TX_BYTES, { acceptDelayedBroadcast: false })).toBe(false);
    expect(shouldDelay(BIG_TX_BYTES + 1, { acceptDelayedBroadcast: false })).toBe(true);
    expect(shouldDelay(BIG_TX_BYTES + 1, undefined)).toBe(true);
  });

  test('a big inscription output counts', () => {
    const bytes = createActionBytes({ outputs: [{ lockingScript: hex(4_200_000) }] });
    expect(bytes).toBeGreaterThan(4_200_000);
    expect(shouldDelay(bytes, { acceptDelayedBroadcast: false })).toBe(true);
  });

  test('input BEEF and unlocking scripts count', () => {
    expect(createActionBytes({ inputBEEF: new Array(1_200_000).fill(0) })).toBeGreaterThan(BIG_TX_BYTES);
    expect(signActionBytes({ spends: { 0: { unlockingScript: hex(1000) } } })).toBe(1000);
  });

  test('steps that do not broadcast now are left alone', () => {
    expect(shouldDelay(5_000_000, { noSend: true })).toBe(false);
    expect(shouldDelay(5_000_000, { signAndProcess: false })).toBe(false);
    expect(shouldDelay(5_000_000, { acceptDelayedBroadcast: true })).toBe(false);
  });

  test('withDelayedBroadcast copies, keeping other options', () => {
    const args = { description: 'mint', options: { acceptDelayedBroadcast: false, randomizeOutputs: false } };
    const out = withDelayedBroadcast(args);
    expect(out.options).toEqual({ acceptDelayedBroadcast: true, randomizeOutputs: false });
    expect(args.options.acceptDelayedBroadcast).toBe(false);
  });
});

describe('response shape', () => {
  test('delayed result answers {txid, pending, sendWithResults sending}', () => {
    const r = pendingShape({ txid: TXID, tx: [1, 2], sendWithResults: [{ txid: TXID, status: 'sending' }] });
    expect(r.txid).toBe(TXID);
    expect((r as { pending?: boolean }).pending).toBe(true);
    expect(r.sendWithResults).toEqual([{ txid: TXID, status: 'sending' }]);
    expect(r.tx).toEqual([1, 2]);
  });

  test('fills sendWithResults when the toolbox left it empty', () => {
    const r = pendingShape({ txid: TXID });
    expect(r.sendWithResults).toEqual([{ txid: TXID, status: 'sending' }]);
  });

  test('no txid: unchanged', () => {
    const r = { signableTransaction: { reference: 'x' } } as { txid?: string };
    expect(pendingShape(r)).toBe(r);
  });
});

describe('kickSendWaiting', () => {
  test('schedules SendWaiting after the 7 s age window, then retries', async () => {
    const at: number[] = [];
    let runs = 0;
    kickSendWaiting(
      async () => {
        runs++;
        return '';
      },
      (fn, ms) => {
        at.push(ms);
        fn();
      },
      () => {},
    );
    await Promise.resolve();
    expect(at).toEqual(KICK_DELAYS_MS);
    expect(at[0]).toBeGreaterThan(7_000);
    expect(runs).toBe(KICK_DELAYS_MS.length);
  });

  test('a failing run never throws', async () => {
    const logs: string[] = [];
    kickSendWaiting(
      async () => {
        throw new Error('offline');
      },
      (fn) => fn(),
      (m) => logs.push(m),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes('offline'))).toBe(true);
  });
});
