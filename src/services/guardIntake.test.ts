import { describe, expect, test } from 'bun:test';
import { createInternalizeBackoff } from './internalizeBackoff';
import { createInternalizeLock } from './internalizeLock';
import { guardIntake, type GuardIntakeDeps } from './guardIntake';
import type { OutpointState } from './heldOutpoints';

const T = 'ab'.repeat(32);
const missing = [{ outpoint: `${T}.0`, satoshis: 6_000_000, address: '' }];

const deps = (states: GuardIntakeDeps['states']) => {
  const calls = { beef: 0, internalize: 0 };
  const backoff = createInternalizeBackoff();
  const d: GuardIntakeDeps = {
    states,
    getBeef: async () => (calls.beef++, [1, 2, 3]),
    internalize: async () => (calls.internalize++, { internalized: 1 }),
    lock: createInternalizeLock(),
    backoff,
  };
  return { d, calls, backoff };
};
const all = (s: OutpointState) => async (ops: string[]) => new Map(ops.map((o) => [o, s]));

describe('the receive guard takes in what storage lacks (review 20, M1 and L3)', () => {
  test('M1: the remote store active (no device store): it internalizes as before, never "succeeds" by skipping', async () => {
    const { d, calls, backoff } = deps(async () => undefined);
    expect(await guardIntake(missing, d)).toEqual([{ txid: T, outcome: 'internalized' }]);
    expect(calls.internalize).toBe(1);
    expect(backoff.due(T)).toBe(true);
  });

  test('L3: every output held by the device store but not counted: no download, no rewrite, its own outcome, backed off', async () => {
    const { d, calls, backoff } = deps(all('stored'));
    expect(await guardIntake(missing, d)).toEqual([{ txid: T, outcome: 'held' }]);
    expect(calls).toEqual({ beef: 0, internalize: 0 });
    expect(backoff.due(T)).toBe(false);
  });

  test('taken in since the check (the address sync or the watcher): no download, no internalize, not a failure', async () => {
    const { d, calls, backoff } = deps(all('accounted'));
    expect(await guardIntake(missing, d)).toEqual([{ txid: T, outcome: 'taken-since' }]);
    expect(calls).toEqual({ beef: 0, internalize: 0 });
    expect(backoff.due(T)).toBe(true);
  });

  test('taken in while the guard downloaded it: re-checked inside the lock, never internalized twice', async () => {
    let state: OutpointState = 'absent';
    const { d, calls } = deps(async (ops) => new Map(ops.map((o) => [o, state])));
    d.getBeef = async () => {
      calls.beef++;
      state = 'accounted'; // the watcher's intake landed meanwhile
      return [1];
    };
    expect(await guardIntake(missing, d)).toEqual([{ txid: T, outcome: 'taken-since' }]);
    expect(calls.internalize).toBe(0);
  });

  test('absent: internalized; no output matched or an error: backed off', async () => {
    const a = deps(all('absent'));
    expect((await guardIntake(missing, a.d))[0].outcome).toBe('internalized');
    const b = deps(all('absent'));
    b.d.internalize = async () => ({ internalized: 0 });
    expect((await guardIntake(missing, b.d))[0].outcome).toBe('no-match');
    expect(b.backoff.due(T)).toBe(false);
    const c = deps(all('absent'));
    c.d.internalize = async () => {
      throw new Error('storage busy');
    };
    expect((await guardIntake(missing, c.d))[0].outcome).toBe('failed');
    expect(c.backoff.due(T)).toBe(false);
  });
});
