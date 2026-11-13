import { describe, expect, test } from 'bun:test';
import { autoResyncCoins, autoResyncMode, type AutoResyncDeps, type WocAnswer } from './autoCoinResync';
import {
  buildSelfCheck,
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

  test('unlock: at least a light run even when one ran a minute ago', () => {
    const now = 10_000_000;
    const s = { at: now - 60_000 * 10, lightAt: now - 60_000 };
    expect(autoResyncMode(s, now)).toBeNull();
    expect(autoResyncMode(s, now, { unlock: true })).toBe('light');
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
