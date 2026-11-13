import { afterEach, describe, expect, test } from 'bun:test';
import { __resetSpendsInFlightForTests, onSpendsInFlight, spendsInFlight, trackSpendsInFlight } from './spendsInFlight';

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
    expect(seen).toEqual([1, 0]);
    await w.listOutputs();
    expect(seen).toEqual([1, 0]);
  });
});
