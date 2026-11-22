/**
 * Instant restore, what the owner sees (owner's restore on 5.2.59, 20 Nov 2026: "Retry moving this account to this
 * device" and "Arriving from your other device: $27.49" read as nonsense). While a snapshot restore runs: one calm line,
 * no "Arriving…", no copy progress, no move notice. Flag off (no `snapshot`): the lines exactly as before. And the
 * initWallet wiring is inert with the flag off: nothing connects, nothing is added.
 */
import { describe, expect, test } from 'bun:test';
import { OUR_BACKUP_INCOMPLETE_LINE, SNAPSHOT_LOADING_LINE, truthLines, type BalanceTruth } from './balanceTruth';
import { FillIncompleteError, type FillProgress } from './backupFill';
import { moveNoticeShows } from '../components/moveToDevice';
import {
  createSpendableFirst,
  holdSendsForSnapshot,
  OUR_BACKUP_RETRY_MS,
  ourBackupAttempt,
  ourBackupRetryTimer,
  oneSatSnapshotLookups,
  type OurServerClient,
  type SendGate,
  type SpendableFirstWiringDeps,
} from './spendableFirstWiring';
import { SNAPSHOT_SEND_WAIT, SNAPSHOT_SERVER_URL } from './spendableFirst';

const NOW = Date.UTC(2026, 10, 20, 12);
const usd = (n: number) => `$${(n / 1e6).toFixed(2)}`;
const truth = (over: Partial<BalanceTruth> = {}): BalanceTruth => ({
  held: [],
  arrivingSats: 27_490_000,
  syncApplies: true,
  sync: { okAt: NOW - 4 * 60_000 },
  restore: { phase: 'checking', arrivingSats: 27_490_000, done: 10, total: 10 },
  ...over,
});

describe('the balance card during an instant restore', () => {
  test('one calm line; never "Arriving…" or the copy progress', () => {
    const texts = truthLines(truth({ snapshot: true }), usd, NOW).map((l) => l.text);
    expect(texts).toContain(SNAPSHOT_LOADING_LINE);
    expect(SNAPSHOT_LOADING_LINE).toBe('Loading older history…');
    expect(texts.join('\n')).not.toMatch(/Arriving|Moving your wallet|Retry/);
  });

  test('flag off (no snapshot field): exactly the lines as before', () => {
    const before = truthLines(truth(), usd, NOW).map((l) => l.text);
    expect(before).toContain('Arriving from your other device: $27.49');
    expect(truthLines(truth({ snapshot: false }), usd, NOW)).toEqual(truthLines(truth(), usd, NOW));
  });

  test('the move notice ("Retry moving this account to this device") is hidden while it runs', () => {
    expect(moveNoticeShows({ onDevice: false })).toBe(true);
    expect(moveNoticeShows({ onDevice: false, snapshotLoading: true })).toBe(false);
    expect(moveNoticeShows({ onDevice: true })).toBe(false);
    expect(moveNoticeShows(null)).toBe(false);
  });
});

describe('initWallet wiring', () => {
  const harness = (on: boolean, over: Partial<SpendableFirstWiringDeps> = {}) => {
    const log: string[] = [];
    const kvStore: Record<string, unknown> = {};
    const client = {
      makeAvailable: async () => (log.push('connect'), { storageIdentityKey: 'server-sik' }),
      getSettings: () => ({ storageIdentityKey: 'server-sik' }),
      findOrInsertUser: async () => (log.push('user'), { user: { userId: 7 } }),
      setActive: async (_a: unknown, sik: string) => void log.push(`setActive:${sik}`),
      rpcCall: async (m: string) => {
        log.push(m);
        return {};
      },
    } as unknown as OurServerClient;
    const w = createSpendableFirst({
      on,
      newClient: () => client,
      device: () => ({ getSettings: () => ({ storageIdentityKey: 'device-sik' }) }) as never,
      identityKey: async () => '02ab',
      deviceActive: () => true,
      tracker: async () => ({ isValidRootForHeight: async () => true }),
      remoteDefaultCoins: async () => 0,
      makeDeviceActive: async () => void log.push('makeDeviceActive'),
      withLock: (fn) => fn(),
      fill: async (_w, restorePoint) => {
        log.push(`fill:${restorePoint ? 'restore-point' : 'full'}`);
        return { how: 'full', pages: 1, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
      },
      addRemote: async (url) => void log.push(`addRemote:${url}`),
      kv: { get: async (k) => ({ [k]: kvStore[k] }), set: async (i) => void Object.assign(kvStore, i) },
      markKey: 'mark',
      ...over,
    });
    return { w, log };
  };

  test('flag off: not used, no connection, no backup added, never loading', async () => {
    const { w, log } = harness(false);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    await w.addOurBackup();
    await w.resume();
    expect(w.loading()).toBe(false);
    expect(log).toEqual([]);
  });

  test('flag on: our server is added as a backup only after its user row names this device', async () => {
    const { w, log } = harness(true);
    expect(await w.addOurBackup()).toBe(true);
    // Review 4: the first fill runs before our server is registered, so no ordinary push sends the whole wallet in
    // the storage locks.
    expect(log).toEqual(['connect', 'user', 'setActive:device-sik', 'fill:full', `addRemote:${SNAPSHOT_SERVER_URL}`]);
  });

  test('flag on, our server offers no snapshot: not used, today’s path runs', async () => {
    const { w, log } = harness(true);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    expect(log).toContain('getCapabilities');
    expect(log).not.toContain('makeDeviceActive');
    expect(w.loading()).toBe(false);
  });
});

describe('mainnet 1p test, 22 Nov 2026 (c, d): an unfinished backup to our server is kept, shown and tried again', () => {
  const progress: FillProgress = {
    stage: 'bulk',
    finalSince: 1,
    offsets: [{ name: 'provenTx', offset: 3 }],
  };
  const make = (
    on: boolean,
    kvStore: Record<string, unknown>,
    clock: { t: number },
    results: (() => unknown)[],
    over: Partial<SpendableFirstWiringDeps> = {},
  ) => {
    const log: string[] = [];
    const resumes: unknown[] = [];
    const unfinished: unknown[] = [];
    const fulls: unknown[] = [];
    const stopped: (() => boolean)[] = [];
    const client = {
      makeAvailable: async () => ({ storageIdentityKey: 'server-sik' }),
      getSettings: () => ({ storageIdentityKey: 'server-sik' }),
      findOrInsertUser: async () => ({ user: { userId: 7 } }),
      setActive: async () => undefined,
    } as unknown as OurServerClient;
    const w = createSpendableFirst({
      on,
      newClient: () => client,
      device: () => ({ getSettings: () => ({ storageIdentityKey: 'device-sik' }) }) as never,
      identityKey: async () => '02ab',
      deviceActive: () => true,
      tracker: async () => ({ isValidRootForHeight: async () => true }),
      remoteDefaultCoins: async () => 0,
      makeDeviceActive: async () => undefined,
      withLock: (fn) => fn(),
      fill: async (_w, _r, o) => {
        log.push('fill');
        resumes.push(o?.resume ?? null);
        unfinished.push(o?.unfinished ?? false);
        fulls.push(o?.full ?? false);
        if (o?.stopped) stopped.push(o.stopped);
        await o?.onProgress?.(progress);
        const next = await results.shift()?.();
        if (next instanceof Error) throw next;
        return { how: 'full', pages: 1, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
      },
      addRemote: async () => void log.push('addRemote'),
      kv: { get: async (k) => ({ [k]: kvStore[k] }), set: async (i) => void Object.assign(kvStore, i) },
      markKey: 'mark',
      now: () => clock.t,
      ...over,
    });
    return { w, log, resumes, unfinished, fulls, stopped };
  };
  const refused = () =>
    new FillIncompleteError('refused', 'WalletStorageClient rpcCall: network error 429', { retryAfterMs: 120_000 });

  test('a refused fill: not registered, kept with its progress, "Backup incomplete, will retry", Retry-After honoured', async () => {
    const kv: Record<string, unknown> = {};
    const clock = { t: NOW };
    const { w, log } = make(true, kv, clock, [refused]);
    expect(await w.addOurBackup()).toBe(false);
    // (d) Our server is no backup of anything it didn't acknowledge: never registered.
    expect(log).toEqual(['fill']);
    expect(w.ourBackup()).toEqual({ incomplete: true, retryAt: NOW + 120_000 });
    // (c) Shown on the balance card, in the lines it already shows.
    const texts = truthLines(truth({ ourBackupIncomplete: true }), usd, NOW).map((l) => l.text);
    expect(texts).toContain(OUR_BACKUP_INCOMPLETE_LINE);
    expect(OUR_BACKUP_INCOMPLETE_LINE).toBe('Backup incomplete, will retry');
    expect(truthLines(truth(), usd, NOW).map((l) => l.text)).not.toContain(OUR_BACKUP_INCOMPLETE_LINE);
    // Kept across a restart: a new wallet open reads it back.
    const again = make(true, kv, clock, []);
    await again.w.resume();
    expect(again.w.ourBackup()).toEqual({ incomplete: true, retryAt: NOW + 120_000 });
  });

  test('(b) never a tight resend: no try before the back-off; after it, the fill goes on from its kept progress', async () => {
    const kv: Record<string, unknown> = {};
    const clock = { t: NOW };
    const { w, log, resumes } = make(true, kv, clock, [refused, () => undefined]);
    expect(await w.addOurBackup()).toBe(false);
    clock.t = NOW + 119_000;
    expect(await w.addOurBackup()).toBe(false);
    expect(log).toEqual(['fill']);
    clock.t = NOW + 121_000;
    expect(await w.addOurBackup()).toBe(true);
    expect(log).toEqual(['fill', 'fill', 'addRemote']);
    expect(resumes).toEqual([null, progress]);
    expect(w.ourBackup()).toEqual({ incomplete: false });
    expect(kv['mark:ourBackupFill']).toBeNull();
  });

  test('(b) back-off without a Retry-After grows with each unfinished try; a stalled fill starts again', async () => {
    const kv: Record<string, unknown> = {};
    const clock = { t: NOW };
    const failed = () => new Error('WalletStorageClient rpcCall: network error 503');
    const stalled = () => new FillIncompleteError('stalled', 'backup fill made no progress');
    const { w, resumes } = make(true, kv, clock, [failed, failed, stalled, () => undefined]);
    expect(await w.addOurBackup()).toBe(false);
    expect(w.ourBackup().retryAt).toBe(NOW + OUR_BACKUP_RETRY_MS[0]);
    clock.t = w.ourBackup().retryAt!;
    expect(await w.addOurBackup()).toBe(false);
    expect(w.ourBackup().retryAt).toBe(clock.t + OUR_BACKUP_RETRY_MS[1]);
    clock.t = w.ourBackup().retryAt!;
    expect(await w.addOurBackup()).toBe(false);
    clock.t = w.ourBackup().retryAt!;
    expect(await w.addOurBackup()).toBe(true);
    // The stalled fill's progress is dropped: the try after it starts from the beginning (a restart marker).
    expect(resumes).toEqual([null, progress, progress, { stage: 'restart', offsets: [] }]);
  });

  test('review 2: a stall keeps a restart marker, and every try after an unfinished one is marked unfinished', async () => {
    const kv: Record<string, unknown> = {};
    const clock = { t: NOW };
    const stalled = () => new FillIncompleteError('stalled', 'backup fill made no progress');
    const { w, resumes, unfinished } = make(true, kv, clock, [stalled, () => undefined]);
    expect(await w.addOurBackup()).toBe(false);
    expect((kv['mark:ourBackupFill'] as { progress: unknown }).progress).toEqual({ stage: 'restart', offsets: [] });
    clock.t = w.ourBackup().retryAt!;
    expect(await w.addOurBackup()).toBe(true);
    // The second fill knows it is unfinished: never "not-needed" on our server's cursor from the first.
    expect(unfinished).toEqual([false, true]);
    expect(resumes[1]).toEqual({ stage: 'restart', offsets: [] });
  });

  test('review 2: a progress write that fails ends the fill as unfinished (never silently swallowed)', async () => {
    const kv: Record<string, unknown> = {};
    const lines: string[] = [];
    const { w, log } = make(true, kv, { t: NOW }, [() => undefined], {
      kv: {
        get: async () => ({}),
        set: async () => {
          throw new Error('QuotaExceededError');
        },
      },
      log: (...a) => void lines.push(a.map(String).join(' ')),
    });
    expect(await w.addOurBackup()).toBe(false);
    expect(log).toEqual(['fill']);
    expect(w.ourBackup().incomplete).toBe(true);
    expect(lines.some((l) => l.includes('could not save the backup fill state'))).toBe(true);
  });

  test('review 3: a closed session’s fill stops and never overwrites the next session’s state', async () => {
    const kv: Record<string, unknown> = {};
    const clock = { t: NOW };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // Session A's fill is still running when the wallet locks and session B opens.
    const a = make(true, kv, clock, [async () => (await held, refused())]);
    const aTry = a.w.addOurBackup();
    await new Promise((r) => setTimeout(r, 0));
    a.w.stop();
    expect(a.stopped[0]()).toBe(true); // the fill ends before its next page
    const b = make(true, kv, clock, [() => undefined]);
    expect(await b.w.addOurBackup()).toBe(true);
    expect(kv['mark:ourBackupFill']).toBeNull();
    release();
    expect(await aTry).toBe(false);
    // A's late failure wrote nothing: B's cleared state stands, no "Backup incomplete" sticks.
    expect(kv['mark:ourBackupFill']).toBeNull();
    expect(b.w.ourBackup()).toEqual({ incomplete: false });
    expect(a.log).toEqual(['fill']);
  });

  test('review 3: kept "incomplete" state while our server is already a saved backup is stale and dropped', async () => {
    const kv: Record<string, unknown> = {
      'mark:ourBackupFill': {
        deviceSik: 'device-sik',
        progress,
        incomplete: { at: NOW, retryAt: NOW + 60_000, reason: 'x', kind: 'refused', failures: 1 },
      },
    };
    const { w, log } = make(true, kv, { t: NOW }, [], { registered: () => true });
    await w.resume();
    expect(w.ourBackup()).toEqual({ incomplete: false });
    expect(kv['mark:ourBackupFill']).toBeNull();
    expect(await w.addOurBackup()).toBe(false);
    expect(log).toEqual([]);
  });

  test('flag off: never incomplete, nothing tried', async () => {
    const { w, log } = make(false, {}, { t: NOW }, [refused]);
    expect(await w.addOurBackup()).toBe(false);
    expect(w.ourBackup()).toEqual({ incomplete: false });
    expect(log).toEqual([]);
  });

  test('review of f2de21bd, 1: an unreadable kept state stops the try (never a fill as if nothing were kept)', async () => {
    const clock = { t: NOW };
    const { w, log } = make(true, {}, clock, [() => undefined], {
      kv: {
        get: async () => {
          throw new Error('storage unavailable');
        },
        set: async () => undefined,
      },
    });
    expect(await w.addOurBackup()).toBe(false);
    // No fill ran: it would have found our server's cursor from a finished pass and registered a half-filled backup.
    expect(log).toEqual([]);
    expect(w.ourBackup()).toEqual({ incomplete: true, retryAt: NOW + OUR_BACKUP_RETRY_MS[0] });
    // Not before the back-off either.
    clock.t = NOW + 1_000;
    expect(await w.addOurBackup()).toBe(false);
    expect(log).toEqual([]);
  });

  test('review of f2de21bd, 4: the background’s retry, wired as background.ts wires it (an alarm, a throw retried)', async () => {
    // background.ts: ourBackupAttempt({ add: ctx.addOurBackup, timer: ourBackupRetryTimer({ setTimer: chrome.alarms }) }).
    const alarms: { name: string; delayInMinutes: number }[] = [];
    const clock = { t: NOW };
    let retryAt: number | undefined;
    const results: (() => Promise<boolean>)[] = [
      async () => {
        retryAt = clock.t + 120_000;
        throw new Error('setActive: network error 503');
      },
      async () => ((retryAt = clock.t + 300_000), false),
      async () => ((retryAt = undefined), true),
    ];
    let tries = 0;
    let attempt!: () => Promise<boolean>;
    const timer = ourBackupRetryTimer({
      retryAt: () => retryAt,
      run: () => void attempt(),
      now: () => clock.t,
      setTimer: (_run, ms) => (alarms.push({ name: 'bwx-our-backup-retry', delayInMinutes: ms / 60_000 }), 'alarm'),
      clearTimer: () => undefined,
    });
    attempt = ourBackupAttempt({ add: () => (tries++, results.shift()!()), timer });
    // A throw (not a false) still arms the retry, at the back-off.
    expect(await attempt()).toBe(false);
    expect(alarms).toEqual([{ name: 'bwx-our-backup-retry', delayInMinutes: 2 }]);
    // The alarm fires: the next try runs; it doesn't land, so the alarm is armed again.
    clock.t += 120_000;
    expect(await attempt()).toBe(false);
    expect(alarms.at(-1)).toEqual({ name: 'bwx-our-backup-retry', delayInMinutes: 5 });
    // The try that lands arms nothing more.
    clock.t += 300_000;
    expect(await attempt()).toBe(true);
    expect(alarms).toHaveLength(2);
    expect(tries).toBe(3);
  });

  describe('a backup an older build registered half-filled (build 153 on the owner’s iPhone): checked once, repaired', () => {
    type Counts = { actions: number; baskets: Record<string, number> };
    const same: Counts = { actions: 9, baskets: { default: 5, tokens: 2 } };
    const setup = (o: {
      server?: () => Promise<Counts> | Counts;
      device?: () => Promise<Counts> | Counts;
      kv?: Record<string, unknown>;
      kvGet?: () => Promise<Record<string, unknown>>;
      kvSet?: (i: Record<string, unknown>) => Promise<void>;
      busy?: () => boolean;
      push?: () => Promise<{ ok: boolean }>;
      detach?: (() => Promise<void>) | null;
      results?: (() => unknown)[];
      clock?: { t: number };
    }) => {
      const kv = o.kv ?? {};
      const calls: string[] = [];
      const server = async () => (o.server ?? (() => same))();
      const client = {
        makeAvailable: async () => ({ storageIdentityKey: 'server-sik' }),
        getSettings: () => ({ storageIdentityKey: 'server-sik' }),
        findOrInsertUser: async () => ({ user: { userId: 7 } }),
        setActive: async () => undefined,
        listActions: async () => (calls.push('server:actions'), { totalActions: (await server()).actions }),
        listOutputs: async (_a: unknown, vargs: { basket: string }) => (
          calls.push(`server:${vargs.basket}`),
          { totalOutputs: (await server()).baskets[vargs.basket] ?? 0 }
        ),
      } as unknown as OurServerClient;
      const m = make(true, kv, o.clock ?? { t: NOW }, o.results ?? [], {
        newClient: () => client,
        registered: () => true,
        deviceCounts: async () => (calls.push('device'), (o.device ?? (() => same))()),
        pushNow: async () => (calls.push('push'), (o.push ?? (async () => ({ ok: true })))()),
        detachRemote: o.detach === null ? undefined : (o.detach ?? (async () => void calls.push('detach'))),
        sleep: async () => undefined,
        busy: o.busy,
        kv: {
          get: o.kvGet ?? (async (k) => ({ [k]: kv[k] })),
          set: o.kvSet ?? (async (i) => void Object.assign(kv, i)),
        },
      });
      const dropped: string[] = [];
      const drop = async () => void dropped.push('ours');
      return { ...m, kv, calls, dropped, drop };
    };
    const short: Counts = { actions: 9, baskets: { default: 3, tokens: 2 } };

    test('counts match (actions, and every basket this device has): done, never asked again on this device', async () => {
      const x = setup({});
      expect(await x.w.checkOurBackup(x.drop)).toBe('match');
      // A push of this device's rows first, then both sides' counts: actions and each basket.
      expect(x.calls).toEqual(['push', 'device', 'server:actions', 'server:default', 'server:tokens']);
      expect(await x.w.checkOurBackup(x.drop)).toBe('done');
      expect(x.dropped).toEqual([]);
      expect(x.w.ourBackup()).toEqual({ incomplete: false });
    });

    for (const [what, server] of [
      ['fewer coins in the default basket', short],
      ['a non-default basket short (tokens, ordinals)', { actions: 9, baskets: { default: 5, tokens: 0 } }],
      [
        'fewer actions (transactions from before the restore point)',
        { actions: 4, baskets: { default: 5, tokens: 2 } },
      ],
      [
        'more spendable there (a coin spent here still spendable there)',
        { actions: 9, baskets: { default: 6, tokens: 2 } },
      ],
    ] as const)
      test(`${what}: repaired once the difference holds after a re-read`, async () => {
        const x = setup({ server: () => server });
        expect(await x.w.checkOurBackup(x.drop)).toBe('repair');
        expect(x.calls.filter((c) => c === 'push')).toHaveLength(2);
        expect(x.dropped).toEqual(['ours']);
      });

    test('a difference that goes away on the re-read (a coin arriving between reads): no repair, recorded as a match', async () => {
      let n = 0;
      const x = setup({ server: () => (n++ < 3 ? short : same) });
      expect(await x.w.checkOurBackup(x.drop)).toBe('match');
      expect(x.dropped).toEqual([]);
    });

    test('the push before the check fails: nothing read, nothing changed, again next open', async () => {
      const x = setup({ push: async () => ({ ok: false }), server: () => short });
      expect(await x.w.checkOurBackup(x.drop)).toBe('error');
      expect(x.dropped).toEqual([]);
      expect(x.kv['mark:ourBackupCheck']).toBeUndefined();
    });

    test('repaired: full restart marker and the record written before the drop; refilled at once in this session', async () => {
      const order: string[] = [];
      const kv: Record<string, unknown> = {};
      const x = setup({
        kv,
        server: () => short,
        kvSet: async (i) => {
          order.push(...Object.keys(i));
          Object.assign(kv, i);
        },
        results: [() => undefined],
      });
      expect(await x.w.checkOurBackup(async () => void order.push('drop'))).toBe('repair');
      expect(order).toEqual(['mark:ourBackupFill', 'mark:ourBackupCheck', 'drop']);
      expect(x.calls).toContain('detach');
      // Out of this session: the incomplete line with a retryAt, so the background arms its retry alarm.
      expect(x.w.ourBackup()).toEqual({ incomplete: true, retryAt: NOW });
      // The retry (alarm) in this same session: the whole fill, as unfinished, from the marker.
      expect(await x.w.addOurBackup()).toBe(true);
      expect(x.unfinished).toEqual([true]);
      expect(x.resumes).toEqual([{ stage: 'restart', offsets: [], full: true }]);
      expect(x.w.ourBackup()).toEqual({ incomplete: false });
    });

    test('review of 0c74701d, 1: a stall during the repair’s fill keeps it a whole fill (full stays sticky)', async () => {
      const clock = { t: NOW };
      const stalled = () => new FillIncompleteError('stalled', 'backup fill made no progress');
      const x = setup({ server: () => short, results: [stalled, () => undefined], clock });
      expect(await x.w.checkOurBackup(x.drop)).toBe('repair');
      expect(await x.w.addOurBackup()).toBe(false);
      const kept = x.kv['mark:ourBackupFill'] as { full?: boolean; progress: unknown; incomplete: { retryAt: number } };
      expect(kept.full).toBe(true);
      expect(kept.progress).toEqual({ stage: 'restart', offsets: [], full: true });
      clock.t = kept.incomplete.retryAt;
      expect(await x.w.addOurBackup()).toBe(true);
      // Both tries were whole fills: never a restore-point fill on our server's cursor after the stall.
      expect(x.fulls).toEqual([true, true]);
      expect(x.resumes[1]).toEqual({ stage: 'restart', offsets: [], full: true });
    });

    test('the record can’t be written: no drop (never a refill -> register -> check loop)', async () => {
      const kv: Record<string, unknown> = {};
      const x = setup({
        kv,
        server: () => short,
        kvSet: async (i) => {
          if ('mark:ourBackupCheck' in i) throw new Error('QuotaExceededError');
          Object.assign(kv, i);
        },
      });
      expect(await x.w.checkOurBackup(x.drop)).toBe('error');
      expect(x.dropped).toEqual([]);
    });

    test('dropping fails: the record is cleared, so the check (and the repair) runs again next open', async () => {
      const x = setup({ server: () => short });
      expect(await x.w.checkOurBackup(async () => Promise.reject(new Error('the account changed')))).toBe('error');
      expect(x.kv['mark:ourBackupCheck']).toBeNull();
    });

    test('our server can’t be taken out of this session: the refill waits for the next open, the line shows', async () => {
      const x = setup({ server: () => short, detach: async () => Promise.reject(new Error('locked')) });
      expect(await x.w.checkOurBackup(x.drop)).toBe('repair');
      expect(x.w.ourBackup().incomplete).toBe(true);
      expect(await x.w.addOurBackup()).toBe(false);
      expect(x.log).toEqual([]);
    });

    test('our server unreachable, or this device’s counts failing: nothing changes, checked again next open', async () => {
      for (const o of [
        { server: () => Promise.reject(new Error('network error 503')) },
        { device: () => Promise.reject(new Error('idb closed')) },
      ]) {
        const x = setup(o);
        expect(await x.w.checkOurBackup(x.drop)).toBe('error');
        expect(x.dropped).toEqual([]);
        expect(x.kv['mark:ourBackupCheck']).toBeUndefined();
        expect(x.kv['mark:ourBackupFill']).toBeUndefined();
      }
    });

    test('its record unreadable, or the marker unwritable: no drop', async () => {
      const a = setup({ kvGet: async () => Promise.reject(new Error('storage unavailable')), server: () => short });
      expect(await a.w.checkOurBackup(a.drop)).toBe('error');
      expect(a.calls).toEqual([]);
      const b = setup({ kvSet: async () => Promise.reject(new Error('QuotaExceededError')), server: () => short });
      expect(await b.w.checkOurBackup(b.drop)).toBe('error');
      expect(b.dropped).toEqual([]);
    });

    test('never beside a payment of its own, and never while a snapshot is still coming in', async () => {
      const x = setup({ busy: () => true, server: () => short });
      expect(await x.w.checkOurBackup(x.drop)).toBe('skip');
      expect(x.calls).toEqual([]);
      const kv: Record<string, unknown> = { mark: { stage: 'full', after: 0, at: NOW } };
      const y = setup({ kv, server: () => short });
      await y.w.resume();
      expect(await y.w.checkOurBackup(y.drop)).toBe('skip');
      expect(y.dropped).toEqual([]);
    });

    test('only our server leaves the saved remotes; every other remote and the active one stay', async () => {
      const { withoutSnapshotRemote } = await import('./spendableFirst');
      const config = { remotes: ['https://wallet.1sat.app', SNAPSHOT_SERVER_URL, 'https://other.example'], x: 1 };
      expect(withoutSnapshotRemote(config)).toEqual({
        remotes: ['https://wallet.1sat.app', 'https://other.example'],
        x: 1,
      });
      const none = { remotes: ['https://wallet.1sat.app'] };
      expect(withoutSnapshotRemote(none)).toBe(none);
    });
  });

  describe('review 5: the background’s retry timer', () => {
    const fake = () => {
      const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
      return {
        timers,
        setTimer: (fn: () => void, ms: number) => {
          const t = { fn, ms, cleared: false };
          timers.push(t);
          return t;
        },
        clearTimer: (t: unknown) => void ((t as { cleared: boolean }).cleared = true),
      };
    };
    test('a retryAt already past (a try that returned early): never sooner than the first back-off step', () => {
      const f = fake();
      let runs = 0;
      const t = ourBackupRetryTimer({ retryAt: () => NOW - 5_000, run: () => void runs++, now: () => NOW, ...f });
      expect(t.schedule()).toBe(true);
      expect(f.timers.map((x) => x.ms)).toEqual([OUR_BACKUP_RETRY_MS[0]]);
      f.timers[0].fn();
      expect(runs).toBe(1);
    });
    test('a later retryAt waits until then; re-arming keeps one timer; nothing to retry arms nothing', () => {
      const f = fake();
      let at: number | undefined = NOW + 300_000;
      const t = ourBackupRetryTimer({ retryAt: () => at, run: () => undefined, now: () => NOW, ...f });
      t.schedule();
      t.schedule();
      expect(f.timers.map((x) => [x.ms, x.cleared])).toEqual([
        [300_000, true],
        [300_000, false],
      ]);
      at = undefined;
      t.cancel();
      expect(t.schedule()).toBe(false);
      expect(f.timers.filter((x) => !x.cleared)).toEqual([]);
    });
  });
});

describe('review 7: flag off never connects or pushes to our server', () => {
  test('our server is left out of the backups with the flag off, even if an earlier session saved it', async () => {
    const { backupsFor } = await import('./spendableFirst');
    const saved = ['https://wallet.1sat.app', SNAPSHOT_SERVER_URL];
    expect(backupsFor(saved, false)).toEqual(['https://wallet.1sat.app']);
    expect(backupsFor(saved, true)).toEqual(saved);
    expect(backupsFor(undefined, false)).toBeUndefined();
  });

  test('wired: both of initWallet’s storage openings filter the backups by the flag', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(src.match(/backupsFor\(resolved\.backups, await spendableFirstOn\(/g)?.length).toBe(2);
  });
});

describe('review 5: wired', () => {
  test('initWallet runs every snapshot page inside the storage manager’s locks', async () => {
    const { readFileSync } = await import('node:fs');
    const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(init).toContain('withLock: (fn) => storage.runAsSync(() => fn())');
    const wiring = readFileSync(new URL('./spendableFirstWiring.ts', import.meta.url), 'utf8');
    expect(wiring.match(/withLock: pageLock/g)?.length).toBe(2); // the lean pages and the background pages
    expect(wiring).toContain('const pageLock = <T>(fn: () => Promise<T>) => serial(() => d.withLock(fn));');
  });
});

describe('1p checks, 21 Nov 2026 (3) and re-review F2: payments fund from coins this device can broadcast', () => {
  // A send before the full snapshot built from coins this device had no bytes for: it came back "failed", posted
  // nothing, and left an unprocessed transaction. Every send (all go through wallet.createAction) funds from verified
  // coins only; only one that needs an unverified coin waits for the snapshot (re-review F2: no wait otherwise).
  const insufficient = Object.assign(new Error('Insufficient funds in the available inputs'), {
    code: 'WERR_INSUFFICIENT_FUNDS',
  });
  const gated = (g: Partial<SendGate> = {}, short = 0) => {
    const built: unknown[] = [];
    let tries = 0;
    const wallet = {
      createAction: async (args: unknown) => {
        if (++tries <= short) throw insufficient;
        built.push(args);
        return { txid: 'ab'.repeat(32) };
      },
    };
    const calls: string[] = [];
    holdSendsForSnapshot(wallet, {
      active: () => true,
      loading: () => true,
      leanRunning: () => false,
      verifiedOnly: async <T>(pay: () => Promise<T>) => {
        calls.push('verifiedOnly');
        try {
          return { ok: true as const, value: await pay(), setAside: 3 };
        } catch (error) {
          return { ok: false as const, error, setAside: 3 };
        }
      },
      settle: async () => (calls.push('settle'), 'settled' as const),
      waitMs: 5,
      ...g,
    });
    return { wallet, built, calls };
  };
  const send = { description: 'a payment', outputs: [{ lockingScript: '00', satoshis: 1, outputDescription: 'x' }] };

  test('not restored from a snapshot (or flag off): goes as before, nothing asked', async () => {
    const x = gated({ active: () => false });
    await x.wallet.createAction(send);
    expect(x.built).toHaveLength(1);
    expect(x.calls).toEqual([]);
  });

  test('first pages still coming in: refused with the wait line, nothing built', async () => {
    const x = gated({ leanRunning: () => true });
    await expect(x.wallet.createAction(send)).rejects.toThrow(SNAPSHOT_SEND_WAIT);
    expect(x.built).toHaveLength(0);
  });

  test('the rest still coming in, verified coins enough: goes at once, never waits', async () => {
    const x = gated({ settle: async () => (x.calls.push('settle'), 'running' as const) });
    await x.wallet.createAction(send);
    expect(x.calls).toEqual(['verifiedOnly']);
    expect(x.built).toHaveLength(1);
  });

  test('needs an unverified coin: waits for the snapshot, then tries once more from verified coins', async () => {
    const x = gated({}, 1);
    await x.wallet.createAction(send);
    expect(x.calls).toEqual(['verifiedOnly', 'settle', 'verifiedOnly']);
    expect(x.built).toHaveLength(1);
  });

  test('needs an unverified coin, snapshot still running (or paused): refused with the wait line, nothing built', async () => {
    for (const state of ['running', 'paused'] as const) {
      const x = gated({ settle: async () => state }, 1);
      await expect(x.wallet.createAction(send)).rejects.toThrow(SNAPSHOT_SEND_WAIT);
      expect(x.built).toHaveLength(0);
    }
  });

  test('short of funds with nothing set aside, or the snapshot done: the toolbox’s own error, as today', async () => {
    const none = gated(
      {
        verifiedOnly: async <T>(pay: () => Promise<T>) => {
          try {
            return { ok: true as const, value: await pay(), setAside: 0 };
          } catch (error) {
            return { ok: false as const, error, setAside: 0 };
          }
        },
      },
      1,
    );
    await expect(none.wallet.createAction(send)).rejects.toThrow(/Insufficient funds/);
    const done = gated({ loading: () => false }, 1);
    await expect(done.wallet.createAction(send)).rejects.toThrow(/Insufficient funds/);
    expect(done.calls).toEqual(['verifiedOnly']);
  });

  test('a sendWith-only call builds nothing: never gated', async () => {
    const x = gated({ leanRunning: () => true });
    await x.wallet.createAction({ description: 'send the batch', options: { sendWith: ['ab'.repeat(32)] } });
    expect(x.built).toHaveLength(1);
  });

  test('flag off: today’s path unchanged: every send goes straight through, the device is never read', async () => {
    let read = 0;
    const { w } = harnessOff(() => void read++);
    const built: unknown[] = [];
    const wallet = { createAction: async (a: unknown) => (built.push(a), { txid: 'cd'.repeat(32) }) };
    expect(w.guardSends(wallet)).toBe(true);
    await w.resume();
    await wallet.createAction(send);
    expect(built).toEqual([send]);
    expect(read).toBe(0);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    expect(read).toBe(0);
  });

  test('wired: initWallet guards the base wallet’s createAction with it', async () => {
    const { readFileSync } = await import('node:fs');
    const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(init).toContain('spendableFirst.guardSends(baseWallet)');
  });
});

/** The wiring with the flag off; `touched` runs if anything reads the device or connects. */
function harnessOff(touched: () => void) {
  const w = createSpendableFirst({
    on: false,
    newClient: () => (touched(), {}) as unknown as OurServerClient,
    device: () => (touched(), undefined),
    identityKey: async () => (touched(), '02ab'),
    deviceActive: () => true,
    tracker: async () => (touched(), { isValidRootForHeight: async () => true }),
    remoteDefaultCoins: async () => (touched(), 0),
    makeDeviceActive: async () => touched(),
    withLock: (fn) => fn(),
    fill: async () => (touched(), { how: 'full', pages: 0, unlockedPages: 0, unlockedMs: 0, lockedMs: [] }),
    addRemote: async () => touched(),
    kv: { get: async () => (touched(), {}), set: async () => touched() },
    markKey: 'mark',
  });
  return { w };
}

describe('1p checks, 21 Nov 2026 (1, 2): the chain lookups the snapshot asks', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);
  const ops = [`${A}.0`, `${A}.1`, `${B}.0`];
  test('spends, by outpoint: asked in both orders; an answer counts only where both agree (re-review F1)', async () => {
    const asked: string[][] = [];
    const index = new Map<string, string | null>([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    const l = oneSatSnapshotLookups({
      txo: { getSpends: async (o: string[]) => (asked.push(o), o.map((x) => index.get(x) ?? null)) },
      beef: { getBeef: async () => [1, 2, 3] },
    });
    const m = await l.spends!(ops);
    expect([...m.entries()]).toEqual([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    expect(asked).toEqual([ops, [...ops].reverse()]);
    expect(await l.chainBeef!('ef'.repeat(32))).toEqual([1, 2, 3]);
  });

  test('a reply in its own order (sorted): the coins whose answers moved get none', async () => {
    const index = new Map<string, string | null>([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    const l = oneSatSnapshotLookups({
      txo: {
        getSpends: async (o: string[]) =>
          [...o]
            .sort()
            .reverse()
            .map((x) => index.get(x) ?? null),
      },
    });
    const m = await l.spends!(ops);
    expect(m.has(ops[0])).toBe(false); // the spent answer lands on another coin in one of the two orders
    expect(m.has(ops[2])).toBe(false);
    expect(m.get(ops[1])).toBe(null); // the middle one stays put in both orders
  });

  test('a short reply: no answers at all', async () => {
    const l = oneSatSnapshotLookups({ txo: { getSpends: async (o: string[]) => o.slice(1).map(() => null) } });
    expect((await l.spends!(ops)).size).toBe(0);
  });

  test('no 1Sat services: no lookups (the restore then falls back to today’s path)', () => {
    expect(oneSatSnapshotLookups(undefined)).toEqual({});
  });
});
