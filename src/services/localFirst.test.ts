import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEVICE_DATA_COPY,
  deviceDataState,
  LOCAL_STORE_NEEDED_MESSAGE,
  DEVICE_DATA_NOTE,
  LocalStoreNeededError,
  ensureLocalStore,
  isOnDeviceStore,
  SEND_WAIT_MS,
  joinOrStartMove,
  movingMessage,
  moveProgressTracker,
  requireLocalStoreForChange,
  RETRY_ANSWER_MS,
  retryMoveAnswer,
  stillMovingText,
  type EnsureLocalDeps,
  type StoreConfigLike,
} from './localFirst';
import { errorLayout, isMovingError } from '../mobile/themeStore/buySheetState';
import { switchToLocalVerified, type SwitchDeps, type SwitchResult } from './restoreFromRemote';

const REMOTE = 'https://wallet.1sat.app';
const S = { outputs: 1, spendableSats: 10, actions: 1 };

/** A wallet's storage as the background sees it: which store is active, what the config says. */
function harness(
  config: StoreConfigLike,
  over: Partial<EnsureLocalDeps> & { switchOk?: boolean; localActive?: boolean } = {},
) {
  const state = {
    local: over.localActive ?? !config?.activeRemote,
    config,
    switches: 0,
    pulls: 0,
    /** Was the remote ever the active store while this ran (the old switch flipped to it first)? */
    remoteWasActive: false,
    saved: [] as unknown[],
    failed: [] as string[],
  };
  const deps: EnsureLocalDeps = {
    account: () => ({ id: 'acct', config: state.config }),
    failedThisSession: () => false,
    backupInFlight: () => false,
    isLocalActive: () => state.local,
    switchVerified: async (): Promise<SwitchResult> => {
      state.switches++;
      // As restoreFromRemote.switchToLocalVerified does: the remote is made active first, then the device again.
      state.local = false;
      state.remoteWasActive = true;
      if (over.switchOk === false)
        return { ok: false, reason: 'device still holds less than the backup', activeIsRemote: true };
      state.local = true;
      return { ok: true, remote: S, local: S };
    },
    localIsEmpty: async () => false,
    pullIntoLocal: async () => void state.pulls++,
    save: async (c) => {
      state.saved.push(c);
      state.config = c;
    },
    onFailed: async (id) => void state.failed.push(id),
    ...over,
  };
  return { state, deps };
}

describe('every account moves to this device on open (P0, 3 Nov 2026)', () => {
  test('a remote-active account → open → this device active, config saved local-first', async () => {
    const { state, deps } = harness({ activeRemote: REMOTE, remotes: [REMOTE] });
    expect(await ensureLocalStore(deps)).toEqual({ ok: true, how: 'switched' });
    expect(state.local).toBe(true);
    expect(state.saved).toEqual([{ activeRemote: undefined, remotes: [REMOTE], localFirst: true }]);
    expect(isOnDeviceStore(state.config)).toBe(true);
  });

  test('an account that once picked the remote (localFirst set) is moved too: it used to be skipped', async () => {
    const { state, deps } = harness({ activeRemote: REMOTE, remotes: [REMOTE], localFirst: true });
    expect((await ensureLocalStore(deps)).ok).toBe(true);
    expect(state.switches).toBe(1);
    expect(state.local).toBe(true);
  });

  test('the device copy not verified: stays on the backup, nothing saved, the failure handed on', async () => {
    const { state, deps } = harness({ activeRemote: REMOTE, remotes: [REMOTE] }, { switchOk: false });
    const r = await ensureLocalStore(deps);
    expect(r.ok).toBe(false);
    expect(state.local).toBe(false);
    expect(state.saved).toEqual([]);
    expect(state.failed).toEqual(['acct']);
  });

  test('a switch that broke storage this session is not retried; a master backup in progress is not interrupted', async () => {
    const a = harness({ activeRemote: REMOTE }, { failedThisSession: () => true });
    expect((await ensureLocalStore(a.deps)).ok).toBe(false);
    expect(a.state.switches).toBe(0);
    const b = harness({ activeRemote: REMOTE }, { backupInFlight: () => true });
    expect(await ensureLocalStore(b.deps)).toEqual({ ok: false, how: 'busy' });
    expect(b.state.switches).toBe(0);
  });

  test('already on this device: nothing to do; an EMPTY device store beside a backup is pulled in', async () => {
    const a = harness({ remotes: [REMOTE], localFirst: true });
    expect(await ensureLocalStore(a.deps)).toEqual({ ok: true, how: 'already-local' });
    expect(a.state.switches).toBe(0);
    const b = harness({ remotes: [REMOTE], localFirst: true }, { localIsEmpty: async () => true });
    expect(await ensureLocalStore(b.deps)).toEqual({ ok: true, how: 'pulled' });
    expect(b.state.pulls).toBe(1);
    expect(b.state.switches).toBe(0);
  });

  test('F-C: an empty device store is pulled into while it stays active; the remote is never made active', async () => {
    // Release click-through, 4 Nov 2026: every open of an empty wallet flipped the active store to wallet.1sat.app
    // (device → remote → device), and a Recover change in that window was refused or hit the toolbox's
    // "does not support StorageProvider" error.
    const b = harness({ remotes: [REMOTE], localFirst: true }, { localIsEmpty: async () => true });
    let localDuringPull: boolean | undefined;
    b.deps.pullIntoLocal = async (url) => {
      expect(url).toBe(REMOTE);
      localDuringPull = b.deps.isLocalActive();
      b.state.pulls++;
    };
    expect(await ensureLocalStore(b.deps)).toEqual({ ok: true, how: 'pulled' });
    expect(localDuringPull).toBe(true);
    expect(b.state.remoteWasActive).toBe(false);
    expect(b.state.local).toBe(true);
    expect(b.state.saved).toEqual([]);
    expect(b.state.failed).toEqual([]);
  });

  test('F-C: a backup that is slow or failing never puts an on-device account back on the remote', async () => {
    const b = harness(
      { remotes: [REMOTE], localFirst: true },
      {
        localIsEmpty: async () => true,
        pullIntoLocal: async () => {
          throw new Error('Remote storage connection timeout: https://wallet.1sat.app');
        },
      },
    );
    const r = await ensureLocalStore(b.deps);
    expect(r).toEqual({
      ok: true,
      how: 'pull-failed',
      reason: 'Remote storage connection timeout: https://wallet.1sat.app',
    });
    expect(b.state.remoteWasActive).toBe(false);
    expect(b.state.local).toBe(true);
    // Nothing saved: in particular never { activeRemote: REMOTE, localFirst: false } as the old switch path did.
    expect(b.state.saved).toEqual([]);
    expect(b.state.failed).toEqual([]);
  });

  test('a device-only account (no remote) is fine as it is', async () => {
    const { deps } = harness(undefined, { localActive: true });
    expect((await ensureLocalStore(deps)).ok).toBe(true);
  });
});

describe('HARD RULE: no payment builds change while the remote store is active', () => {
  const wallet = () => {
    const calls: unknown[] = [];
    return {
      calls,
      createAction: async (args: unknown) => {
        calls.push(args);
        return { txid: 'ab'.repeat(32) };
      },
    };
  };
  const pay = { description: 'pay', outputs: [{ lockingScript: '76a9', satoshis: 1000 }] };

  test('remote active: the device store is made active first, then the payment is built there', async () => {
    const w = wallet();
    let local = false;
    let asked = 0;
    requireLocalStoreForChange(w, {
      isLocal: () => local,
      ensureLocal: async () => (asked++, (local = true)),
      log: () => undefined,
    });
    await w.createAction(pay);
    expect(asked).toBe(1);
    expect(w.calls.length).toBe(1);
  });

  test('the device store cannot be made active: refused in plain words, nothing built', async () => {
    const w = wallet();
    requireLocalStoreForChange(w, { isLocal: () => false, ensureLocal: async () => false, log: () => undefined });
    const e = await w.createAction(pay).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(LocalStoreNeededError);
    expect((e as Error).message).toMatch(/Nothing was sent/);
    expect(w.calls).toEqual([]);
    // No way to switch at all (no callback): refused too.
    const w2 = wallet();
    requireLocalStoreForChange(w2, { isLocal: () => false, log: () => undefined });
    await expect(w2.createAction(pay)).rejects.toBeInstanceOf(LocalStoreNeededError);
    // ensureLocal says yes but the remote is still active: refused.
    const w3 = wallet();
    requireLocalStoreForChange(w3, { isLocal: () => false, ensureLocal: async () => true, log: () => undefined });
    await expect(w3.createAction(pay)).rejects.toBeInstanceOf(LocalStoreNeededError);
  });

  test('a call that builds nothing (sendWith of a stored tx) is not held up', async () => {
    const w = wallet();
    requireLocalStoreForChange(w, { isLocal: () => false, ensureLocal: async () => false, log: () => undefined });
    await w.createAction({ description: 'send it', options: { sendWith: ['ab'.repeat(32)] } });
    expect(w.calls.length).toBe(1);
  });

  test('wired: initWallet guards the base wallet; the background answers with the verified switch', () => {
    const init = readFileSync('src/initWallet.ts', 'utf8');
    expect(init).toContain('requireLocalStoreForChange(baseWallet');
    expect(init).toContain('ensureLocal: options?.ensureLocalStore');
    const bg = readFileSync('src/background.ts', 'utf8');
    expect(bg).toContain('ensureLocalStore: () => ensureLocalForPayment()');
    // The old "once per account" skip for an account with localFirst set is gone.
    expect(bg).not.toContain('if (config.activeRemote && !config.localFirst) {');
  });

  test('the honest copy, word for word', () => {
    expect(DEVICE_DATA_NOTE).toBe(
      "This account's change may need your device data. Keep this device until it shows Up to date.",
    );
    expect(readFileSync('src/pages/Settings.tsx', 'utf8')).toMatch(/<ShowSeedWords[\s\S]*?showDeviceData[\s\S]*?\/>/);
    expect(readFileSync('src/pages/onboarding/RestoreAccount.tsx', 'utf8')).toContain(
      '<DeviceDataNote state="remote" />',
    );
  });
});

describe('review 4 Nov 2026', () => {
  test('F11: the copy says where the records really are', () => {
    const b = { backupConfigured: true, pendingPush: false, failures: 0, lastPushOkAt: 1 };
    expect(deviceDataState({ onDevice: false, ...b })).toBe('remote');
    expect(deviceDataState({ onDevice: true, ...b })).toBe('up-to-date');
    expect(deviceDataState({ onDevice: true, ...b, backupConfigured: false })).toBe('device-only');
    expect(deviceDataState({ onDevice: true, ...b, pendingPush: true })).toBe('device-only');
    expect(deviceDataState({ onDevice: true, ...b, failures: 2 })).toBe('device-only');
    expect(deviceDataState({ onDevice: true, ...b, lastPushOkAt: 0 })).toBe('device-only');
    // Review 19 F4: a backup set aside after a failed merge says so, and that it retries by itself.
    expect(deviceDataState({ onDevice: true, ...b, paused: true })).toBe('backup-paused');
    expect(deviceDataState({ onDevice: false, ...b, paused: true })).toBe('remote');
    expect(DEVICE_DATA_COPY['device-only']).toBe(DEVICE_DATA_NOTE);
    expect(DEVICE_DATA_COPY.remote).toMatch(/online backup/);
  });

  test('F4: never a silent permanent refusal: the message names the retry; failures back off; the retry is wired', () => {
    expect(LOCAL_STORE_NEEDED_MESSAGE).toMatch(/Retry moving this account to this device/);
    expect(LOCAL_STORE_NEEDED_MESSAGE).toMatch(/Nothing was sent/);
    const bg = readFileSync('src/background.ts', 'utf8');
    expect(bg).toContain('const MOVE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000];');
    expect(bg).toContain('failedThisSession: (id) => moveInBackoff(id),');
    expect(bg).toMatch(/'STORAGE_MOVE_STATUS',\s*'STORAGE_MOVE_TO_DEVICE',/); // extension pages only
    expect(bg).toContain("case 'STORAGE_MOVE_TO_DEVICE':");
    for (const page of ['src/pages/BsvWallet.tsx', 'src/pages/StorageStatus.tsx', 'src/mobile/themeStore/StoreBuy.tsx'])
      expect(readFileSync(page, 'utf8')).toContain('<MoveToDeviceNotice');
  });
});

describe('a send during the copy (never a second copy, refuse within 2 s with progress)', () => {
  const never = () => new Promise<void>(() => undefined);
  /**
   * "Within 2 s" is the wait the code asks for, not the wall clock (the full gate run under load took 2.28 s, 22 Nov
   * 2026): every timer `fn` sets is recorded and fires at once, so the refusal path runs whole and fast under any load.
   */
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; waits: number[] }> => {
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
      waits.push(ms ?? 0);
      return real(cb, 0, ...a);
    }) as typeof setTimeout;
    try {
      return { value: await fn(), waits };
    } finally {
      globalThis.setTimeout = real;
    }
  };

  test('joins the copy already running: start() is never called', async () => {
    let starts = 0;
    const { value: ok, waits } = await timed(() =>
      joinOrStartMove({
        isLocal: () => false,
        running: () => never(),
        start: async () => void starts++,
        waitMs: 50,
      }),
    );
    expect(ok).toBe(false);
    expect(starts).toBe(0);
    // It waits only its own waitMs for the copy already running, never for the copy to finish.
    expect(waits).toEqual([50]);
  });

  test('starts exactly one copy when none runs, and a second send joins it', async () => {
    let starts = 0;
    let running: Promise<unknown> | null = null;
    const deps = {
      isLocal: () => false,
      running: () => running,
      start: () => {
        starts++;
        running = never();
        return running;
      },
      waitMs: 20,
    };
    await joinOrStartMove(deps);
    await joinOrStartMove(deps);
    await joinOrStartMove(deps);
    expect(starts).toBe(1);
  });

  test('once coins are admitted (local active), a send proceeds without waiting', async () => {
    const ok = await joinOrStartMove({
      isLocal: () => true,
      running: () => never(),
      start: never,
      waitMs: 10_000,
    });
    expect(ok).toBe(true);
  });

  test('the wrapped createAction refuses within 2 s with the progress message and signs nothing', async () => {
    let built = 0;
    let local = false;
    const wallet = { createAction: async () => void built++ };
    requireLocalStoreForChange(wallet, {
      isLocal: () => local,
      ensureLocal: () =>
        joinOrStartMove({ isLocal: () => local, running: () => never(), start: never, waitMs: SEND_WAIT_MS }),
      // 4.5 min for 250 → 13.5 min for the other 750 → "about 14". Not on a whole minute: movingMessage reads the clock
      // again, and 5 min here landed exactly on 15.0, so any delay made it "16" on a slow CI runner.
      refusal: () => movingMessage({ done: 250, total: 1000, startedAt: Date.now() - 4.5 * 60_000 }),
      log: () => undefined,
    });
    const { value: err, waits } = await timed(() => wallet.createAction({ outputs: [{}] } as never).catch((e) => e));
    // Refused after one wait of SEND_WAIT_MS (2 s at most), never after the copy: the copy here never ends.
    expect(SEND_WAIT_MS).toBeLessThanOrEqual(2000);
    expect(waits).toEqual([SEND_WAIT_MS]);
    expect(err).toBeInstanceOf(LocalStoreNeededError);
    expect(err.message).toBe(
      'Moving your wallet to this device: 250 of 1000. You can send in about 14 minutes. Nothing was sent.',
    );
    expect(built).toBe(0);
    // Coins admitted: the same wrapped send now goes through.
    local = true;
    await wallet.createAction({ outputs: [{}] } as never);
    expect(built).toBe(1);
  });

  test('the progress message is recognised by the popup as the moving notice', () => {
    expect(isMovingError(movingMessage({ done: 1, total: 4, startedAt: Date.now() - 60_000 }))).toBe(true);
    expect(isMovingError(movingMessage(null))).toBe(true);
  });
});

describe("task 70 review: one switch for every caller (B1), the move's own counts (B2)", () => {
  /** A switch whose copy (setActiveStorage('local')) waits until released; counts the copies started. */
  const fakeSwitch = (key: object, remoteUrl = 'https://backup.example') => {
    let active: string | undefined = remoteUrl;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const copies = { started: 0 };
    const summary = { outputs: 1, spendableSats: 100, actions: 1 };
    const deps: SwitchDeps = {
      key,
      remoteUrl,
      activeRemoteUrl: () => active,
      setActiveStorage: async (t) => {
        if (t === 'local') {
          copies.started++;
          await gate;
          active = undefined;
        } else active = t;
      },
      summarize: async () => summary,
      pullRemote: async () => undefined,
    };
    return { deps, release, copies };
  };

  test('B1: a second caller (Recover mined, Restore from backup) joins the running switch: one copy', async () => {
    const store = {};
    const a = fakeSwitch(store);
    const first = switchToLocalVerified(a.deps);
    await new Promise((r) => setTimeout(r, 5));
    // Another caller, its own deps for the same account's store.
    const b = fakeSwitch(store);
    const second = switchToLocalVerified(b.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(a.copies.started + b.copies.started).toBe(1);
    a.release();
    b.release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2).toBe(r1);
    expect(b.copies.started).toBe(0);
    // Once it has finished, a later switch runs again.
    const c = fakeSwitch(store);
    c.release();
    expect((await switchToLocalVerified(c.deps)).ok).toBe(true);
    expect(c.copies.started).toBe(1);
  });

  test("B1: a switch to a different backup waits for the running one; another account's store is not held up", async () => {
    const store = {};
    const a = fakeSwitch(store, 'https://one.example');
    const b = fakeSwitch(store, 'https://two.example');
    const other = fakeSwitch({});
    const first = switchToLocalVerified(a.deps);
    const second = switchToLocalVerified(b.deps);
    const third = switchToLocalVerified(other.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(a.copies.started).toBe(1);
    expect(b.copies.started).toBe(0); // never two copies into one store at once
    expect(other.copies.started).toBe(1);
    a.release();
    b.release();
    other.release();
    await Promise.all([first, second, third]);
    expect(b.copies.started).toBe(1);
  });

  test("B2: the counts come from the move's own admission runs, and only while it runs", async () => {
    let now = 1_000_000;
    const t = moveProgressTracker(() => now);
    t.admission({ admitted: 5, applied: 0, refused: 0, retired: 0, left: 10 }); // no move: ignored
    expect(t.current()).toBeNull();
    let finish!: () => void;
    const move = t.track(() => new Promise<void>((r) => (finish = r)));
    expect(t.message()).toBe(movingMessage(null)); // nothing checked yet: the plain line
    now += 60_000;
    t.admission({ admitted: 40, applied: 0, refused: 10, retired: 0, left: 150 });
    expect(t.current()).toEqual({ done: 50, total: 200, startedAt: 1_000_000 });
    now += 60_000;
    t.admission({ admitted: 50, applied: 0, refused: 0, retired: 0, left: 100 });
    expect(t.message()).toBe(
      'Moving your wallet to this device: 100 of 200. You can send in about 2 minutes. Nothing was sent.',
    );
    finish();
    await move;
    expect(t.current()).toBeNull();
    expect(t.message()).toBe(movingMessage(null));
  });

  test('B2: a move that fails leaves no counts behind', async () => {
    const t = moveProgressTracker(() => 0);
    const failed = t.track(async () => {
      t.admission({ admitted: 3, applied: 0, refused: 0, retired: 0, left: 7 });
      expect(t.current()?.total).toBe(10);
      throw new Error('copy to this device failed');
    });
    await expect(failed).rejects.toThrow('copy to this device failed');
    expect(t.current()).toBeNull();
    expect(t.message()).toBe(movingMessage(null));
  });

  test('B2: the Store pay sheet shows the same progress line, not the short generic one', () => {
    const line = movingMessage({ done: 3, total: 9, startedAt: Date.now() - 60_000 });
    expect(errorLayout(line)).toEqual({ hero: false, notice: true, error: line });
    expect(errorLayout(movingMessage(null)).error).toBe(movingMessage(null));
  });
});

describe('instant restore (services/spendableFirst.ts) in ensureLocalStore', () => {
  const OURS = 'https://storage.bwalletx.com';

  test('used on a remote-active restore: no verified copy, saved local-first with our server added as a backup', async () => {
    const { state, deps } = harness({ activeRemote: REMOTE, remotes: [REMOTE] });
    const asked: string[] = [];
    deps.spendableFirst = async (url) => {
      asked.push(url);
      state.local = true; // the snapshot path makes the device store active itself
      return { used: true, remotes: [OURS] };
    };
    expect(await ensureLocalStore(deps)).toEqual({ ok: true, how: 'snapshot' });
    expect(asked).toEqual([REMOTE]);
    expect(state.switches).toBe(0);
    expect(state.saved).toEqual([{ activeRemote: undefined, remotes: [REMOTE, OURS], localFirst: true }]);
  });

  test('not used (or throws): exactly the path without it, step for step', async () => {
    const run = async (snap?: EnsureLocalDeps['spendableFirst']) => {
      const h = harness({ activeRemote: REMOTE, remotes: [REMOTE] });
      if (snap) h.deps.spendableFirst = snap;
      const r = await ensureLocalStore(h.deps);
      return { r, switches: h.state.switches, saved: h.state.saved, failed: h.state.failed };
    };
    const without = await run();
    expect(await run(async () => ({ used: false }))).toEqual(without);
    expect(await run(() => Promise.reject(new Error('boom')))).toEqual(without);
    const runEmpty = async (snap?: EnsureLocalDeps['spendableFirst']) => {
      const h = harness({ remotes: [REMOTE], localFirst: true }, { localIsEmpty: async () => true });
      if (snap) h.deps.spendableFirst = snap;
      const r = await ensureLocalStore(h.deps);
      return { r, pulls: h.state.pulls, saved: h.state.saved };
    };
    expect(await runEmpty(async () => ({ used: false }))).toEqual(await runEmpty());
  });

  test('an empty local-active device: the snapshot instead of the pull; our server added once', async () => {
    const h = harness({ remotes: [REMOTE], localFirst: true }, { localIsEmpty: async () => true });
    h.deps.spendableFirst = async () => ({ used: true, remotes: [OURS] });
    expect(await ensureLocalStore(h.deps)).toEqual({ ok: true, how: 'snapshot' });
    expect(h.state.pulls).toBe(0);
    expect(h.state.saved).toEqual([{ remotes: [REMOTE, OURS], localFirst: true }]);
    // A device that already holds rows never asks for it.
    const full = harness({ remotes: [REMOTE], localFirst: true });
    let asked = 0;
    full.deps.spendableFirst = async () => {
      asked++;
      return { used: false };
    };
    expect(await ensureLocalStore(full.deps)).toEqual({ ok: true, how: 'already-local' });
    expect(asked).toBe(0);
  });
});

describe('review of a95a1ff0, 1: the backup a move to this device reads from is never our server unless it is safe', () => {
  const OURS = 'https://storage.bwalletx.com';
  test('remotes = [ours] only (1Sat removed), flag off: no remote picked, nothing switched', async () => {
    const { state, deps } = harness({ remotes: [`${OURS}.`] }, { localActive: false });
    const r = await ensureLocalStore(deps);
    expect(state.switches).toBe(0);
    expect(r.ok).toBe(false);
  });
  test('ours first, 1Sat second: 1Sat is the one read from', async () => {
    let asked: string | undefined;
    const { deps } = harness(
      { remotes: [OURS, REMOTE] },
      { localActive: false, switchVerified: async (url) => ((asked = url), { ok: true, remote: S, local: S }) },
    );
    await ensureLocalStore(deps);
    expect(asked).toBe(REMOTE);
  });
  test('a pick the background supplies (flag on, repaired) may name our server', async () => {
    let asked: string | undefined;
    const { deps } = harness(
      { remotes: [OURS] },
      {
        localActive: false,
        pickRemote: async () => OURS,
        switchVerified: async (url) => ((asked = url), { ok: true, remote: S, local: S }),
      },
    );
    await ensureLocalStore(deps);
    expect(asked).toBe(OURS);
  });
});

describe('Retry moving this account to this device answers in about 2 s (5.2.62)', () => {
  const never = () => new Promise<void>(() => undefined);
  /** Every timer the code sets is recorded and fires at once: "about 2 s" is the wait asked for, not the clock. */
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; waits: number[] }> => {
    const real = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
      waits.push(ms ?? 0);
      return real(cb, 0, ...a);
    }) as typeof setTimeout;
    try {
      return { value: await fn(), waits };
    } finally {
      globalThis.setTimeout = real;
    }
  };
  type S = {
    moving: boolean;
    reason: string | null;
    progress: { done: number; total: number; startedAt: number } | null;
  };

  test('Retry waits RETRY_ANSWER_MS for a move that runs on, answers "Still moving: N of M", never starts a second', async () => {
    expect(RETRY_ANSWER_MS).toBe(2000);
    let starts = 0;
    let running: Promise<unknown> | null = null;
    const status = (): S => ({
      moving: running !== null,
      reason: null,
      progress: { done: 12, total: 40, startedAt: 0 },
    });
    // The background's moveToDeviceNow, as wired: joinOrStartMove with the wait the caller asks for.
    const moveNow = (waitMs: number) =>
      joinOrStartMove({
        isLocal: () => false,
        running: () => running,
        start: () => {
          starts++;
          running = never();
          return running;
        },
        waitMs,
      });
    const first = await timed(() => retryMoveAnswer({ moveNow, status }));
    expect(first.waits).toEqual([RETRY_ANSWER_MS]);
    expect(first.value).toEqual({ success: false, data: status(), error: 'Still moving: 12 of 40' });
    const again = await timed(() => retryMoveAnswer({ moveNow, status }));
    expect(again.waits).toEqual([RETRY_ANSWER_MS]);
    expect(starts).toBe(1);
  });

  test('a move that ended: done, or its reason', async () => {
    const st = (reason: string | null): S => ({ moving: false, reason, progress: null });
    expect(await retryMoveAnswer({ moveNow: async () => true, status: () => st(null) })).toEqual({
      success: true,
      data: st(null),
    });
    expect((await retryMoveAnswer({ moveNow: async () => false, status: () => st('backup short') })).error).toBe(
      'backup short',
    );
    expect((await retryMoveAnswer({ moveNow: async () => false, status: () => st(null) })).error).toBe('not moved yet');
  });

  test('"Still moving: N of M" once there are counts', () => {
    expect(stillMovingText(null)).toBe('Still moving');
    expect(stillMovingText({ done: 0, total: 0 })).toBe('Still moving');
    expect(stillMovingText({ done: 12, total: 40 })).toBe('Still moving: 12 of 40');
    expect(stillMovingText({ done: 41, total: 40 })).toBe('Still moving: 40 of 40');
  });

  test('wired: Retry answers through retryMoveAnswer; Recover change keeps its long wait', () => {
    const bg = readFileSync('src/background.ts', 'utf8');
    const start = bg.indexOf("case 'STORAGE_MOVE_TO_DEVICE':");
    const handler = bg.slice(start, bg.indexOf('return true;', start));
    expect(handler).toContain('await retryMoveAnswer({ moveNow: moveToDeviceNow, status: moveStatus })');
    expect(handler).not.toContain('await moveToDeviceNow()');
    expect(bg).toContain('const moveToDeviceNow = async (waitMs = 90_000): Promise<boolean> =>');
    expect(bg).toContain('return ensureLocalForPayment(waitMs);');
    expect(bg).toContain('moveNow: () => moveToDeviceNow(),');
    expect(bg).toContain('progress: moveProgress.current(),');
  });
});
