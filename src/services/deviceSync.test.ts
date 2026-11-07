import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_MS,
  PUSH_DELAY_MS,
  SLOW_SYNC_MS,
  backupBeforeSend,
  createDeviceSync,
  notifyOnWalletChanges,
} from './deviceSync';

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

  test('review 20, L6: a pull asked for while a push runs is not swallowed by it: the pull runs once the push is done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const { sync } = harness({
      pull: async () => void calls.push('pull'),
      push: async () => {
        calls.push('push');
        await gate;
      },
    });
    const pushing = sync.pushNow();
    await new Promise((r) => setTimeout(r, 0));
    const a = sync.syncNow();
    const b = sync.syncNow(); // a second ask while the first waits: one pull
    release();
    await Promise.all([pushing, a, b]);
    expect(calls).toEqual(['push', 'pull', 'push']);
    expect(await a).toMatchObject({ ok: true, pulled: true });
  });

  test('review 20, N4: a pull waiting on a push never runs at the same time as a pushNow that started meanwhile', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let active = 0;
    let most = 0;
    let pushes = 0;
    const work = async (what: string, gate?: Promise<void>) => {
      active++;
      most = Math.max(most, active);
      calls.push(what);
      await (gate ?? new Promise((r) => setTimeout(r, 5)));
      active--;
    };
    const calls: string[] = [];
    const { sync } = harness({
      pull: () => work('pull'),
      push: () => work('push', ++pushes === 1 ? gateA : undefined),
    });
    const a = sync.pushNow(); // the debounced push, running
    await new Promise((r) => setTimeout(r, 0));
    const b = sync.pushNow(); // a Store payment's backup-before-send, waiting for it
    const full = sync.syncNow(); // a pull asked for after that: also waits
    releaseA();
    await Promise.all([a, full, b]);
    expect(most).toBe(1);
    expect(calls.filter((c) => c === 'pull').length).toBe(1);
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

describe('pushNow / backupBeforeSend: a Store payment is broadcast only after its rows are backed up (P0, 3 Nov 2026)', () => {
  test('pushNow starts a NEW push after the call: it never joins one that began before the rows were written', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    let n = 0;
    const sync = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => undefined,
      push: async () => {
        const me = ++n;
        order.push(`push${me} start`);
        if (me === 1) await first;
        order.push(`push${me} end`);
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const early = sync.syncNow(); // a push already in flight (started before the payment's rows existed)
    await new Promise((r) => setTimeout(r, 0));
    const now = sync.pushNow();
    release();
    expect((await early).ok).toBe(true);
    const r = await now;
    expect(r).toEqual({ ok: true, pulled: false, pushed: true });
    expect(order).toEqual(['push1 start', 'push1 end', 'push2 start', 'push2 end']);
  });

  test('pushNow reports a failed push, and waits briefly for a site mid-action before giving up', async () => {
    const failing = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => undefined,
      push: async () => {
        throw new Error('wallet.1sat.app 503');
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    expect(await failing.pushNow()).toEqual({ ok: false, error: 'wallet.1sat.app 503' });
    let busy = true;
    const waits: number[] = [];
    const busyOne = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => undefined,
      push: async () => undefined,
      busy: () => busy,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    const stillBusy = await busyOne.pushNow({ busyWaitMs: [1, 1], sleep: async (ms) => void waits.push(ms) });
    expect(stillBusy.ok).toBe(false);
    expect(waits).toEqual([1, 1]);
    const freed = busyOne.pushNow({ busyWaitMs: [1], sleep: async () => void (busy = false) });
    expect(await freed).toEqual({ ok: true, pulled: false, pushed: true });
  });

  test('backupBeforeSend: ok only when the push went through (or the rows live on the remote store)', async () => {
    const quiet = () => undefined;
    const pushed = async () => ({ ok: true as const, pulled: false, pushed: true });
    const failed = async () => ({ ok: false as const, error: 'offline' });
    const yes = () => true;
    const no = () => false;
    expect(await backupBeforeSend({ deviceActive: yes, backupConfigured: yes, pushNow: pushed, log: quiet })).toEqual({
      ok: true,
      how: 'pushed',
    });
    expect(await backupBeforeSend({ deviceActive: yes, backupConfigured: yes, pushNow: failed, log: quiet })).toEqual({
      ok: false,
      error: 'offline',
    });
    // A push that "succeeds" without pushing (backup gone) is not a backup.
    const notPushed = async () => ({ ok: true as const, pulled: false, pushed: false });
    expect(
      (await backupBeforeSend({ deviceActive: yes, backupConfigured: yes, pushNow: notPushed, log: quiet })).ok,
    ).toBe(false);
    const threw = async (): Promise<never> => {
      throw new Error('boom');
    };
    expect(await backupBeforeSend({ deviceActive: yes, backupConfigured: yes, pushNow: threw, log: quiet })).toEqual({
      ok: false,
      error: 'boom',
    });
    const hangs = () => new Promise<never>(() => undefined);
    expect(
      await backupBeforeSend({ deviceActive: yes, backupConfigured: yes, pushNow: hangs, timeoutMs: 5, log: quiet }),
    ).toEqual({ ok: false, error: 'the backup took too long' });
    expect(await backupBeforeSend({ deviceActive: no, backupConfigured: yes, pushNow: failed, log: quiet })).toEqual({
      ok: true,
      how: 'remote-active',
    });
    expect(await backupBeforeSend({ deviceActive: yes, backupConfigured: no, pushNow: failed, log: quiet })).toEqual({
      ok: true,
      how: 'no-backup',
    });
  });
});

describe('the backup state for the honest copy (review 4 Nov 2026, F11)', () => {
  test('lastPushOkAt is set only by a push that went through', async () => {
    let fail = true;
    const sync = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => undefined,
      push: async () => {
        if (fail) throw new Error('offline');
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await sync.pushNow();
    expect(sync.state().lastPushOkAt).toBe(0);
    expect(sync.state().failures).toBe(1);
    fail = false;
    await sync.pushNow();
    expect(sync.state().lastPushOkAt).toBeGreaterThan(0);
    expect(sync.state().failures).toBe(0);
  });
});

describe("device sync: a long run says how long it held the storage (owner's seal, 7 Nov 2026)", () => {
  const timedSync = (pullMs: number, pushMs: number) => {
    let t = 0;
    const lines: string[] = [];
    const { sync } = harness({
      pull: async () => void (t += pullMs),
      push: async () => void (t += pushMs),
      now: () => t,
      log: (...a) => void lines.push(a.map(String).join(' ')),
    });
    return { sync, lines };
  };
  test('a full sync at or over SLOW_SYNC_MS logs its pull and push times', async () => {
    const { sync, lines } = timedSync(SLOW_SYNC_MS, 700);
    await sync.syncNow();
    expect(lines).toEqual([`[deviceSync] full took ${SLOW_SYNC_MS + 700} ms (pull ${SLOW_SYNC_MS} ms, push 700 ms)`]);
  });
  test('a quick one logs nothing', async () => {
    const { sync, lines } = timedSync(100, 100);
    await sync.syncNow();
    expect(lines).toEqual([]);
  });
});

describe('device sync: a pull that let an own payment go first carries on in the same run (7 Nov 2026)', () => {
  test("pull 'yielded' → waits for the payment, pulls again from its checkpoint, then pushes", async () => {
    const calls: string[] = [];
    let pulls = 0;
    let release = () => {};
    let paying = true;
    const idle = () => (paying ? new Promise<void>((r) => (release = r)) : Promise.resolve());
    const { sync } = harness({
      pull: async () => {
        calls.push(`pull${++pulls}`);
        if (pulls > 1) return undefined;
        paying = true; // a payment arrived during the first pull, which ended for it
        return 'yielded';
      },
      push: async () => void calls.push('push'),
      yieldTo: { idle },
    });
    paying = false; // the run starts with no payment
    const done = sync.syncNow();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['pull1']); // waiting for the payment, not pulling or pushing
    paying = false;
    release();
    expect(await done).toEqual({ ok: true, pulled: true, pushed: true });
    expect(calls).toEqual(['pull1', 'pull2', 'push']);
  });
});

describe('device sync: after waiting for an own payment, the turn is checked again (review 7 Nov 2026, #4)', () => {
  const waitingRun = (after: { applies?: boolean; busy?: boolean }) => {
    let release = () => {};
    let applies = true;
    let busy = false;
    const calls: string[] = [];
    const { sync } = harness({
      applies: () => applies,
      busy: () => busy,
      pull: async () => void calls.push('pull'),
      push: async () => void calls.push('push'),
      yieldTo: { idle: () => new Promise<void>((r) => (release = r)) },
    });
    const done = sync.syncNow();
    return {
      calls,
      sync,
      finish: async () => {
        applies = after.applies ?? true; // the account switched or the wallet locked during the payment
        busy = after.busy ?? false; // a dApp chain started during the payment
        release();
        return done;
      },
    };
  };
  test('no longer applies (account switch, lock): nothing pulled or pushed', async () => {
    const r = waitingRun({ applies: false });
    expect(await r.finish()).toEqual({ ok: true, pulled: false, pushed: false });
    expect(r.calls).toEqual([]);
  });
  test('a site chain is busy now: deferred, nothing taken, the push stays pending', async () => {
    const r = waitingRun({ busy: true });
    expect(await r.finish()).toEqual({ ok: false, error: 'a site action is in progress; sync deferred' });
    expect(r.calls).toEqual([]);
    expect(r.sync.state().pendingPush).toBe(true);
  });
});
