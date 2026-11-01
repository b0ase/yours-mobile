import { describe, expect, test } from 'bun:test';
import { createMneeRefreshGate, MNEE_MIN_REFRESH_MS } from './mneeRefreshGate';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('MNEE refresh gate', () => {
  test('single flight: callers during a run share it', async () => {
    const gate = createMneeRefreshGate({ now: () => 0 });
    const d = deferred<number>();
    let runs = 0;
    const job = () => {
      runs++;
      return d.promise;
    };
    const a = gate.run('acct', job);
    const b = gate.run('acct', job, { force: true });
    expect(gate.busy('acct')).toBe(true);
    d.resolve(5);
    expect(await a).toBe(5);
    expect(await b).toBe(5);
    expect(runs).toBe(1);
    expect(gate.busy('acct')).toBe(false);
  });

  test('gap discovery runs once per session per account; later runs start from what it found', async () => {
    let t = 0;
    const gate = createMneeRefreshGate({ now: () => t });
    const plans: { discover: boolean; knownMaxKeyIndex?: number }[] = [];
    const job = async (plan: { discover: boolean; knownMaxKeyIndex?: number }) => {
      plans.push(plan);
      if (plan.discover) gate.markDiscovered('acct', 42);
      return 1;
    };
    await gate.run('acct', job);
    t += MNEE_MIN_REFRESH_MS;
    await gate.run('acct', job);
    await gate.run('acct', job, { force: true });
    await gate.run('other', job);
    expect(plans).toEqual([
      { discover: true, knownMaxKeyIndex: undefined },
      { discover: false, knownMaxKeyIndex: 42 },
      { discover: false, knownMaxKeyIndex: 42 },
      { discover: true, knownMaxKeyIndex: undefined },
    ]);
  });

  test('a failed discovery (never marked) is tried again on the next run', async () => {
    let t = 0;
    const gate = createMneeRefreshGate({ now: () => t });
    const plans: boolean[] = [];
    await gate.run('acct', async (p) => (plans.push(p.discover), undefined));
    t += MNEE_MIN_REFRESH_MS;
    await gate.run('acct', async (p) => (plans.push(p.discover), undefined));
    expect(plans).toEqual([true, true]);
  });

  test('without force, at most one run per minute; callers in between get the last answer', async () => {
    let t = 0;
    const gate = createMneeRefreshGate({ now: () => t });
    let runs = 0;
    const job = async () => ++runs * 10;
    expect(await gate.run('acct', job)).toBe(10);
    t += 30_000;
    expect(gate.due('acct')).toBe(false);
    expect(await gate.run('acct', job)).toBe(10);
    t += 29_999;
    expect(await gate.run('acct', job)).toBe(10);
    expect(runs).toBe(1);
    t += 1;
    expect(gate.due('acct')).toBe(true);
    expect(await gate.run('acct', job)).toBe(20);
    expect(await gate.run('acct', job, { force: true })).toBe(30);
  });

  test('a throwing job releases the flight', async () => {
    const gate = createMneeRefreshGate({ now: () => 0 });
    await expect(
      gate.run('acct', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(gate.busy('acct')).toBe(false);
    expect(await gate.run('acct', async () => 1, { force: true })).toBe(1);
  });

  test('no account: nothing runs', async () => {
    const gate = createMneeRefreshGate();
    let runs = 0;
    expect(await gate.run('', async () => ++runs)).toBeUndefined();
    expect(runs).toBe(0);
  });

  test('reset forgets discovery and the interval (lock)', async () => {
    const gate = createMneeRefreshGate({ now: () => 0 });
    const plans: boolean[] = [];
    const job = async (p: { discover: boolean }) => {
      plans.push(p.discover);
      gate.markDiscovered('acct', 4);
      return 1;
    };
    await gate.run('acct', job);
    gate.reset();
    await gate.run('acct', job);
    expect(plans).toEqual([true, true]);
  });
});
