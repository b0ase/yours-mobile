import { afterEach, describe, expect, test } from 'bun:test';
import { __resetSpendsInFlightForTests, onSpendsInFlight, spendsInFlight, trackSpendsInFlight } from './spendsInFlight';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('spendsInFlight (web one-tab handover waits for running payments)', () => {
  afterEach(() => __resetSpendsInFlightForTests());

  const wallet = () => {
    const gates: Array<() => void> = [];
    const pending = () => new Promise<string>((resolve) => gates.push(() => resolve('done')));
    return {
      gates,
      w: {
        createAction: pending,
        signAction: pending,
        createSignature: async (_args: { hashToDirectlySign?: number[]; data?: number[] }) => 'sig',
        listOutputs: async () => [],
      },
    };
  };

  test('createAction and signAction count while they run; the count comes back down', async () => {
    const { w, gates } = wallet();
    trackSpendsInFlight(w);
    const seen: number[] = [];
    onSpendsInFlight((n) => seen.push(n));
    const a = w.createAction();
    const b = w.signAction();
    expect(spendsInFlight()).toBe(2);
    gates.forEach((g) => g());
    expect(await a).toBe('done');
    await b;
    await tick(1);
    expect(spendsInFlight()).toBe(0);
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  test('a failed payment still comes off the count', async () => {
    const w = {
      createAction: async () => {
        throw new Error('refused');
      },
    };
    trackSpendsInFlight(w);
    await expect(w.createAction()).rejects.toThrow('refused');
    await tick(1);
    expect(spendsInFlight()).toBe(0);
  });

  test('only digest signatures count; other calls pass straight through; wrapping twice counts once', async () => {
    const { w } = wallet();
    trackSpendsInFlight(w);
    trackSpendsInFlight(w);
    const seen: number[] = [];
    onSpendsInFlight((n) => seen.push(n));
    await w.createSignature({ data: [1] });
    expect(seen).toEqual([]);
    await w.createSignature({ hashToDirectlySign: [1] });
    await tick(1);
    expect(seen).toEqual([1, 0]);
    await w.listOutputs();
    expect(seen).toEqual([1, 0]);
  });

  test('reviewer probe: the count reaches 0 only after the caller has recorded the result', async () => {
    const log: string[] = [];
    const w = trackSpendsInFlight({
      createAction: async () => {
        await tick(5);
        return { txid: 'x' };
      },
    });
    onSpendsInFlight((n) => log.push(`spends ${n}`));
    const pay = (async () => {
      await w.createAction();
      log.push('caller records result');
    })();
    await pay;
    await tick(1);
    expect(log).toEqual(['spends 1', 'caller records result', 'spends 0']);
  });
});
