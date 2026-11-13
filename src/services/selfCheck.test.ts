import { describe, expect, test } from 'bun:test';
import {
  AUTO_RESYNC_UNLOCK_FLOOR_MS,
  autoResyncCoins,
  autoResyncMode,
  runAutoResyncIfDue,
  type AutoResyncDeps,
  type AutoResyncReport,
  type WocAnswer,
} from './autoCoinResync';
import {
  buildSelfCheck,
  createSelfCheckRunner,
  SELF_CHECK_KEY,
  SELF_CHECK_MAX_MISMATCHES,
  type SelfCheckRead,
  type SelfCheckResult,
  coinFingerprint,
  compareFingerprints,
  readSelfCheck,
  saveSelfCheck,
  stuckSyncCount,
  STUCK_SYNC_NOTICE_MS,
} from './selfCheck';

const T = (c: string) => c.repeat(64);
const A = `${T('a')}_0`;
const B = `${T('b')}_1`;
const C = `${T('c')}_2`;
const SPENDER = T('5');
const OTHER = T('6');
const BUILD = '5.2.57';

/** A wallet with three coins; the caller says what the index and WhatsOnChain answer. */
const wallet = (over: Partial<AutoResyncDeps> = {}) => {
  const spent: Record<string, string> = {};
  const d: AutoResyncDeps = {
    coins: [A, B, C],
    sats: { [A]: 10_000, [B]: 2_000, [C]: 300 },
    cleared: {},
    ownPendingTxids: new Set(),
    ownPendingInputs: new Set(),
    getSpends: async (b) => b.map(() => null),
    woc: async () => null,
    markSpent: async (o, by) => ((spent[o] = by), 1),
    markUnspent: async () => 1,
    ...over,
  };
  const read = { coins: d.coins, sats: d.sats!, holds: { count: 0, sats: 0 } };
  return { d, spent, read };
};

describe('self-check: coins spent on chain', () => {
  test('both sources name the same spender: marked spent, reported as fixed, not as a difference', async () => {
    const { d, spent, read } = wallet({
      getSpends: async (b) => b.map((o) => (o === B ? SPENDER : null)),
      woc: async (o) => (o === B ? { txid: SPENDER, confirmed: false } : null),
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({ [B]: SPENDER });
    expect(r.mismatches).toEqual([{ outpoint: B, sats: 2_000, kind: 'marked-spent' }]);
    const s = buildSelfCheck(r, read, BUILD, 1000)!;
    expect(s.differsBySats).toBe(0);
    expect(s.coins).toBe(3);
    // The fingerprint is of the coins left after the fix.
    expect(s.fingerprint.sats).toBe(10_300);
    expect(s.fingerprint.count).toBe(2);
  });

  test('one confirmed (mined) WhatsOnChain spend, index silent: marked spent in a full run', async () => {
    const { d, spent } = wallet({
      woc: async (o): Promise<WocAnswer> => (o === C ? { txid: SPENDER, confirmed: true } : null),
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({ [C]: SPENDER });
    expect(r.mismatches?.map((m) => m.kind)).toEqual(['marked-spent']);
  });
});

describe('self-check: undecidable coins are left alone', () => {
  test('index names a spender, WhatsOnChain says unspent: no change, reported as a difference', async () => {
    const { d, spent, read } = wallet({
      getSpends: async (b) => b.map((o) => (o === A ? SPENDER : null)),
      woc: async () => null,
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    expect(r.released).toBe(0);
    const s = buildSelfCheck(r, read, BUILD, 1000)!;
    expect(s.mismatches).toEqual([{ outpoint: A, sats: 10_000, kind: 'unconfirmed-spend' }]);
    expect(s.differsBySats).toBe(10_000);
    // Nothing was removed from the records.
    expect(s.fingerprint.sats).toBe(12_300);
  });

  test('sources name different spenders: no change', async () => {
    const { d, spent } = wallet({
      getSpends: async (b) => b.map((o) => (o === A ? SPENDER : null)),
      woc: async (o) => (o === A ? { txid: OTHER, confirmed: true } : null),
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    expect(r.mismatches?.map((m) => m.kind)).toEqual(['unconfirmed-spend']);
  });

  test('a WhatsOnChain mempool spend alone: no change', async () => {
    const { d, spent } = wallet({ woc: async (o) => (o === B ? { txid: SPENDER, confirmed: false } : null) });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    expect(r.mismatches).toEqual([{ outpoint: B, sats: 2_000, kind: 'unconfirmed-spend' }]);
  });

  test('both lookups fail: no change, no difference claimed, counted as unchecked', async () => {
    const { d, spent, read } = wallet({
      getSpends: async () => {
        throw new Error('index down');
      },
      woc: async () => {
        throw new Error('woc down');
      },
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    const s = buildSelfCheck(r, read, BUILD, 1000)!;
    expect(s.mismatches).toEqual([]);
    expect(s.differsBySats).toBe(0);
    expect(s.unchecked).toBe(3);
  });

  test("writing the verdict fails: the coin stays, reported as 'update-failed' (still a difference)", async () => {
    const { d, read } = wallet({
      getSpends: async (b) => b.map((o) => (o === B ? SPENDER : null)),
      woc: async (o) => (o === B ? { txid: SPENDER, confirmed: true } : null),
      markSpent: async () => {
        throw new Error('storage busy');
      },
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(r.released).toBe(0);
    expect(r.cleared).toEqual({});
    expect(buildSelfCheck(r, read, BUILD, 1000)!.differsBySats).toBe(2_000);
  });
});

describe('self-check result', () => {
  test('a foreground run (biggest coins only) makes no result', async () => {
    const { d, read } = wallet();
    const r = await autoResyncCoins({ ...d, mode: 'foreground' });
    expect(buildSelfCheck(r, read, BUILD, 1000)).toBeNull();
  });

  test('unsent holds and stuck syncs are carried through', async () => {
    const { d, read } = wallet();
    const r = await autoResyncCoins({ ...d, mode: 'light' });
    const stuck = { syncMap: JSON.stringify({ bwxFullPass: { startedAt: 1, stuckMs: STUCK_SYNC_NOTICE_MS } }) };
    const s = buildSelfCheck(r, { ...read, holds: { count: 1, sats: 700 }, syncStates: [stuck] }, BUILD, 1000)!;
    expect(s.mode).toBe('light');
    expect(s.unsentHolds).toEqual({ count: 1, sats: 700 });
    expect(s.stuckSyncs).toBe(1);
  });

  test('stuckSyncCount: only a pass from the start that has not moved', () => {
    const row = (m: object) => ({ syncMap: { bwxFullPass: m } });
    expect(stuckSyncCount(undefined)).toBe(0);
    expect(
      stuckSyncCount([
        row({ startedAt: 1, stuckMs: STUCK_SYNC_NOTICE_MS }),
        row({ startedAt: 1, stuckMs: 1000 }), // moving
        row({ doneAt: 5, stuckMs: STUCK_SYNC_NOTICE_MS }), // finished
        { syncMap: 'not json' },
      ]),
    ).toBe(1);
  });

  test('stored per account and read back; unknown account reads null', async () => {
    const store: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    };
    const { d, read } = wallet();
    const s = buildSelfCheck(await autoResyncCoins({ ...d, mode: 'light' }), read, BUILD, 1000)!;
    await saveSelfCheck(kv, 'idk1', s);
    expect(await readSelfCheck(kv, 'idk1')).toEqual(s);
    expect(await readSelfCheck(kv, 'idk2')).toBeNull();
  });

  test('unlock: a light run once the floor has passed, never more often', () => {
    const now = 10_000_000;
    const at = now - 60_000 * 10;
    expect(autoResyncMode({ at, lightAt: now - 60_000 }, now)).toBeNull();
    // Worker cold start / account switch a minute after the last run: nothing due.
    expect(autoResyncMode({ at, lightAt: now - 60_000 }, now, { unlock: true })).toBeNull();
    expect(autoResyncMode({ at, lightAt: now - AUTO_RESYNC_UNLOCK_FLOOR_MS + 1 }, now, { unlock: true })).toBeNull();
    expect(autoResyncMode({ at, lightAt: now - AUTO_RESYNC_UNLOCK_FLOOR_MS }, now, { unlock: true })).toBe('light');
    expect(autoResyncMode({}, now, { unlock: true })).toBe('full');
  });
});

describe('cross-device fingerprint', () => {
  const coins = [
    { outpoint: A, sats: 10_000 },
    { outpoint: B, sats: 2_000 },
    { outpoint: C, sats: 300 },
  ];

  test('same coin set in any order: same fingerprint, agrees', () => {
    const one = coinFingerprint(coins, BUILD, 1);
    const two = coinFingerprint([coins[2], coins[0], coins[1]], '5.2.51', 2);
    expect(two.coinListHash).toBe(one.coinListHash);
    expect(two.sats).toBe(12_300);
    expect(compareFingerprints(one, two)).toEqual({ state: 'agrees' });
  });

  test('upper/lower case and duplicates do not change it', () => {
    const one = coinFingerprint(coins, BUILD, 1);
    const two = coinFingerprint([...coins, { outpoint: A.toUpperCase(), sats: 10_000 }], BUILD, 1);
    expect(two).toEqual(one);
  });

  test('other device holds a coin this one lacks: shows that much more', () => {
    const mine = coinFingerprint(coins.slice(0, 2), BUILD, 1);
    const other = coinFingerprint(coins, BUILD, 1);
    expect(compareFingerprints(mine, other)).toEqual({
      state: 'differs',
      deltaSats: 300,
      message: 'Other device shows 300 sats more',
    });
  });

  test('other device lacks a coin: shows that much less (custom formatting)', () => {
    const mine = coinFingerprint(coins, BUILD, 1);
    const other = coinFingerprint([coins[1], coins[2]], BUILD, 1);
    const r = compareFingerprints(mine, other, (s) => `$${(s / 1000).toFixed(2)}`);
    expect(r).toEqual({ state: 'differs', deltaSats: -10_000, message: 'Other device shows $10.00 less' });
  });

  test('same total in different coins: differs with a zero delta', () => {
    const mine = coinFingerprint([{ outpoint: A, sats: 500 }], BUILD, 1);
    const other = coinFingerprint([{ outpoint: B, sats: 500 }], BUILD, 1);
    const r = compareFingerprints(mine, other);
    expect(r.state).toBe('differs');
    expect(r.state === 'differs' && r.deltaSats).toBe(0);
  });
});

describe('self-check review fixes (13 Nov 2026)', () => {
  test('only a full run on both sources with nothing unsettled claims "agrees"', async () => {
    const full = wallet();
    const f = buildSelfCheck(await autoResyncCoins({ ...full.d, mode: 'full' }), full.read, BUILD, 1)!;
    expect(f.verifiedBy).toBe('index+woc');
    expect(f.agrees).toBe(true);
    const light = wallet();
    const l = buildSelfCheck(await autoResyncCoins({ ...light.d, mode: 'light' }), light.read, BUILD, 1)!;
    expect(l.verifiedBy).toBe('index');
    expect(l.differsBySats).toBe(0);
    expect(l.agrees).toBe(false);
    // Off mainnet (no WhatsOnChain) a full run is index-only.
    const noWoc = wallet({ woc: undefined });
    const n = buildSelfCheck(await autoResyncCoins({ ...noWoc.d, mode: 'full' }), noWoc.read, BUILD, 1)!;
    expect(n.verifiedBy).toBe('index');
    expect(n.agrees).toBe(false);
  });

  test('full run: WhatsOnChain fails for a coin the index calls unspent → unchecked, no "agrees"', async () => {
    const { d, read } = wallet({
      woc: async (o) => {
        if (o === C) throw new Error('network down'); // (a 429 is retried first, then the same)
        return null;
      },
    });
    const s = buildSelfCheck(await autoResyncCoins({ ...d, mode: 'full' }), read, BUILD, 1)!;
    expect(s.unchecked).toBe(1);
    expect(s.differsBySats).toBe(0);
    expect(s.agrees).toBe(false);
  });

  test('index names a spender, WhatsOnChain throws (429/timeout): unchecked, not a difference, no change', async () => {
    const { d, spent, read } = wallet({
      getSpends: async (b) => b.map((o) => (o === A ? SPENDER : null)),
      woc: async (o) => {
        if (o === A) throw new Error('timeout');
        return null;
      },
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    const s = buildSelfCheck(r, read, BUILD, 1)!;
    expect(s.mismatches).toEqual([]);
    expect(s.differsBySats).toBe(0);
    expect(s.unchecked).toBe(1);
  });

  test('light run, index down: a big coin WhatsOnChain calls unspent is still unchecked', async () => {
    const { d, spent, read } = wallet({
      getSpends: async () => {
        throw new Error('index down');
      },
      woc: async () => null,
    });
    const s = buildSelfCheck(await autoResyncCoins({ ...d, mode: 'light' }), read, BUILD, 1)!;
    expect(spent).toEqual({});
    expect(s.unchecked).toBe(3);
    expect(s.differsBySats).toBe(0);
  });

  test('index down, WhatsOnChain names a mempool spend of a big coin: unchecked (one source), no change', async () => {
    const { d, spent, read } = wallet({
      getSpends: async () => {
        throw new Error('index down');
      },
      woc: async (o) => (o === A ? { txid: SPENDER, confirmed: false } : null),
    });
    const s = buildSelfCheck(await autoResyncCoins({ ...d, mode: 'light' }), read, BUILD, 1)!;
    expect(spent).toEqual({});
    expect(s.mismatches).toEqual([]);
    expect(s.unchecked).toBe(3);
  });

  test('markSpent finds nothing spendable (an in-flight send got there first): out of the fingerprint', async () => {
    const { d, read } = wallet({
      getSpends: async (b) => b.map((o) => (o === B ? SPENDER : null)),
      woc: async (o) => (o === B ? { txid: SPENDER, confirmed: true } : null),
      markSpent: async () => 0,
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(r.released).toBe(0);
    const s = buildSelfCheck(r, read, BUILD, 1)!;
    expect(s.fingerprint.count).toBe(2);
    expect(s.fingerprint.sats).toBe(10_300);
    expect(s.differsBySats).toBe(0);
  });

  test('a restored coin shows in mismatches and the fingerprint; one from another basket is not added', async () => {
    const R = `${T('7')}_0`; // default basket, not spendable (cleared earlier)
    const X = `${T('8')}_0`; // another basket (e.g. tokens), on the cleared list
    const { d, read } = wallet({
      cleared: { [R]: SPENDER, [X]: SPENDER },
      sats: { [A]: 10_000, [B]: 2_000, [C]: 300, [R]: 4_000 },
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(r.restored).toBe(2);
    const s = buildSelfCheck(r, { ...read, sats: d.sats! }, BUILD, 1)!;
    expect(s.mismatches).toContainEqual({ outpoint: R, sats: 4_000, kind: 'restored' });
    expect(s.fingerprint.count).toBe(4);
    expect(s.fingerprint.sats).toBe(16_300);
  });

  test("a deposit coin held by the wallet's own pending action is skipped", async () => {
    const DEP = `${T('9')}_1`;
    const { d, spent, read } = wallet({
      coins: [A, DEP],
      sats: { [A]: 10_000, [DEP]: 1_200 },
      ownPendingInputs: new Set([DEP]),
      getSpends: async (b) => b.map((o) => (o === DEP ? SPENDER : null)),
      woc: async (o) => (o === DEP ? { txid: SPENDER, confirmed: true } : null),
    });
    const r = await autoResyncCoins({ ...d, mode: 'full' });
    expect(spent).toEqual({});
    expect(r.checked).toBe(1);
    expect(buildSelfCheck(r, read, BUILD, 1)!.mismatches).toEqual([]);
  });

  test('mismatches capped at 50 (unsettled first, biggest first), the total kept', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      outpoint: `${T((i % 16).toString(16))}_${i}`,
      sats: i + 1,
      kind: (i % 2 ? 'marked-spent' : 'unconfirmed-spend') as 'marked-spent' | 'unconfirmed-spend',
    }));
    const report: AutoResyncReport = {
      checked: 120,
      released: 60,
      restored: 0,
      cleared: {},
      mode: 'full',
      mismatches: many,
    };
    const s = buildSelfCheck(report, { coins: [], sats: {}, holds: { count: 0, sats: 0 } }, BUILD, 1)!;
    expect(s.mismatches.length).toBe(SELF_CHECK_MAX_MISMATCHES);
    expect(s.mismatchCount).toBe(120);
    expect(s.mismatches.every((m) => m.kind === 'unconfirmed-spend')).toBe(true);
    expect(s.mismatches[0].sats).toBe(119);
    // differsBySats is over all of them, not the kept ones.
    expect(s.differsBySats).toBe(many.filter((m) => m.kind === 'unconfirmed-spend').reduce((t, m) => t + m.sats, 0));
  });

  test('saving drops results of accounts no longer in the wallet', async () => {
    const store: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    };
    const { d, read } = wallet();
    const s = buildSelfCheck(await autoResyncCoins({ ...d, mode: 'light' }), read, BUILD, 1)!;
    await saveSelfCheck(kv, 'gone', s);
    await saveSelfCheck(kv, 'other', s);
    await saveSelfCheck(kv, 'me', s, ['me', 'other']);
    expect(Object.keys(store[SELF_CHECK_KEY] as object).sort()).toEqual(['me', 'other']);
    // A list that doesn't hold this account is not trusted: nothing dropped.
    await saveSelfCheck(kv, 'new', s, ['me']);
    expect(Object.keys(store[SELF_CHECK_KEY] as object).sort()).toEqual(['me', 'new', 'other']);
  });
});

describe('self-check runner (the worker wiring)', () => {
  type Ctx = { id: number };
  const setup = (over: { gate?: Promise<void>; switchAfterRun?: boolean } = {}) => {
    const store: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    };
    let ctx: Ctx | null = { id: 1 };
    let clock = 1_000_000_000;
    const announced: SelfCheckResult[] = [];
    const loads: number[] = [];
    const changed: AutoResyncReport[] = [];
    const runner = createSelfCheckRunner<Ctx>({
      kv,
      current: () => (ctx ? { key: 'idk', ctx } : null),
      isCurrent: (key, c) => key === 'idk' && ctx === c,
      // The real throttle and persisted state, as the worker uses them.
      run: (key, c, o, onRead) =>
        runAutoResyncIfDue(
          key,
          kv,
          async (cleared) => {
            loads.push(clock);
            if (over.gate) await over.gate;
            const { d, read } = wallet({
              cleared,
              getSpends: async (b) => b.map((x) => (x === B ? SPENDER : null)),
              woc: async (x) => (x === B ? { txid: SPENDER, confirmed: true } : null),
            });
            onRead(read as SelfCheckRead);
            if (over.switchAfterRun) ctx = { id: c.id + 1 };
            return d;
          },
          clock,
          o,
        ),
      buildId: () => BUILD,
      announce: (r) => announced.push(r),
      onChanged: (r) => changed.push(r),
      accounts: () => ['idk'],
      now: () => clock,
    });
    return {
      runner,
      store,
      announced,
      loads,
      changed,
      tick: (ms: number) => void (clock += ms),
      lock: () => void (ctx = null),
    };
  };

  test('a run: the read is captured, the result built, stored and announced; the balance change reported', async () => {
    const t = setup();
    await t.runner({ unlock: true });
    expect(t.loads.length).toBe(1);
    expect(t.changed.length).toBe(1);
    expect(t.announced.length).toBe(1);
    expect(t.announced[0].mismatches).toEqual([{ outpoint: B, sats: 2_000, kind: 'marked-spent' }]);
    expect((t.store[SELF_CHECK_KEY] as Record<string, SelfCheckResult>).idk).toEqual(t.announced[0]);
  });

  test('unlock within the floor: no second run, the stored result is announced again', async () => {
    const t = setup();
    await t.runner({ unlock: true });
    t.tick(10_000);
    await t.runner({ unlock: true }); // worker cold start / account switch 10 s later
    expect(t.loads.length).toBe(1);
    expect(t.announced.length).toBe(2);
    expect(t.announced[1]).toEqual(t.announced[0]);
    t.tick(AUTO_RESYNC_UNLOCK_FLOOR_MS);
    await t.runner({ unlock: true });
    expect(t.loads.length).toBe(2);
    // Ten unlocks a second apart cost no run.
    for (let i = 0; i < 10; i++) {
      t.tick(1_000);
      await t.runner({ unlock: true });
    }
    expect(t.loads.length).toBe(2);
  });

  test('account switched (or locked) while the run was going: nothing stored or announced', async () => {
    const t = setup({ switchAfterRun: true });
    await t.runner({ unlock: true });
    expect(t.loads.length).toBe(1);
    expect(t.announced).toEqual([]);
    expect(t.store[SELF_CHECK_KEY]).toBeUndefined();
  });

  test('locked: no run', async () => {
    const t = setup();
    t.lock();
    await t.runner({ unlock: true });
    expect(t.loads).toEqual([]);
  });

  test('calls while a run is busy queue one follow-up run (options merged), not dropped and not one each', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = setup({ gate });
    const first = t.runner({});
    await new Promise((r) => setTimeout(r, 0));
    expect(t.loads.length).toBe(1);
    t.tick(AUTO_RESYNC_UNLOCK_FLOOR_MS + 1);
    const queued = [t.runner({ unlock: true }), t.runner({ foreground: true }), t.runner({ unlock: true })];
    open();
    await first;
    await Promise.all(queued);
    // The follow-up was an unlock past the floor: one more run, not three.
    expect(t.loads.length).toBe(2);
  });
});
