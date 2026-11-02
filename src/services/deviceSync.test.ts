import { describe, expect, test } from 'bun:test';
import { BACKOFF_MS, PUSH_DELAY_MS, createDeviceSync, notifyOnWalletChanges } from './deviceSync';

/** A fake clock: timers run only when the test advances them. */
const clock = () => {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => timers.map((t) => t.at - now),
  };
};

const harness = (over: Partial<Parameters<typeof createDeviceSync>[0]> = {}) => {
  const c = clock();
  const calls: string[] = [];
  const sync = createDeviceSync({
    applies: () => true,
    ensureBackup: async () => true,
    pull: async () => void calls.push('pull'),
    push: async () => void calls.push('push'),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    ...over,
  });
  return { sync, calls, c };
};

describe('device sync: the owner’s devices stay in step through the backup (2 Nov 2026)', () => {
  test('syncNow pulls the other devices’ changes first, then pushes this one’s', async () => {
    const { sync, calls } = harness();
    expect(await sync.syncNow()).toEqual({ ok: true, pulled: true, pushed: true });
    expect(calls).toEqual(['pull', 'push']);
  });

  test('a change pushes ~20 s later; a burst of changes pushes once', async () => {
    const { sync, calls, c } = harness();
    sync.changed();
    await c.advance(5_000);
    sync.changed();
    sync.changed();
    await c.advance(PUSH_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await c.advance(1);
    expect(calls).toEqual(['push']);
  });

  test('a backup that will not connect backs off: 1, 2, 4 … minutes', async () => {
    let up = false;
    const { sync, calls, c } = harness({ ensureBackup: async () => up });
    const r = await sync.syncNow();
    expect(r.ok).toBe(false);
    expect(c.pending()).toEqual([BACKOFF_MS[0]]);
    await c.advance(BACKOFF_MS[0]);
    expect(c.pending()).toEqual([BACKOFF_MS[1]]);
    up = true;
    await c.advance(BACKOFF_MS[1]);
    expect(calls).toEqual(['push']);
    expect(sync.state().failures).toBe(0);
  });

  test('not this setup (remote active, or no backup): does nothing', async () => {
    const { sync, calls } = harness({ applies: () => false });
    expect(await sync.syncNow()).toEqual({ ok: true, pulled: false, pushed: false });
    expect(calls).toEqual([]);
  });

  test('never takes storage locks while a site is mid-action; tries again shortly', async () => {
    let busy = true;
    const { sync, calls, c } = harness({ busy: () => busy });
    expect((await sync.syncNow()).ok).toBe(false);
    busy = false;
    await c.advance(PUSH_DELAY_MS);
    expect(calls).toEqual(['push']);
  });

  test('two requests at once share one run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const { sync } = harness({
      pull: async () => {
        calls.push('pull');
        await gate;
      },
      push: async () => void calls.push('push'),
    });
    const a = sync.syncNow();
    const b = sync.syncNow();
    release();
    await Promise.all([a, b]);
    expect(calls).toEqual(['pull', 'push']);
  });

  test('wallet writes report a change, even when they throw', async () => {
    let changes = 0;
    const wallet = {
      createAction: async () => ({ txid: 'a' }),
      internalizeAction: async () => {
        throw new Error('nope');
      },
      listOutputs: async () => ({ outputs: [] }),
    };
    expect(notifyOnWalletChanges(wallet, () => changes++)).toBe(true);
    await wallet.createAction();
    await expect(wallet.internalizeAction()).rejects.toThrow('nope');
    await wallet.listOutputs();
    expect(changes).toBe(2);
  });
});
