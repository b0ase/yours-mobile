import { describe, expect, test } from 'bun:test';
import {
  AUTO_RESYNC_FOREGROUND_GAP_MS,
  AUTO_RESYNC_KEY,
  AUTO_RESYNC_LIGHT_GAP_MS,
  autoResyncCoins,
  autoResyncMode,
  bigCoins,
  recordAutoCleared,
  runAutoResyncIfDue,
  type AutoResyncDeps,
  type AutoResyncState,
} from './autoCoinResync';

const T = (c: string) => c.repeat(64);
const SPENDER = T('d');
// The phone's coins of 87ccbc90… (4 Nov 2026): three big ones the extension spent, two small ones still unspent.
const V4 = `${T('8')}_4`;
const V1 = `${T('8')}_1`;
const V0 = `${T('8')}_0`;
const V2 = `${T('8')}_2`;
const V6 = `${T('8')}_6`;
const SATS: Record<string, number> = {
  [V4]: 49_634_148,
  [V1]: 6_967_249,
  [V0]: 4_488_921,
  [V2]: 600_000,
  [V6]: 340_000,
};
const MIN = 60_000;

/** The phone's store and the chain. `indexMisses`: spends the 1sat index hasn't seen (it says unspent). */
function phone() {
  const store: Record<string, boolean> = Object.fromEntries(Object.keys(SATS).map((o) => [o, true]));
  const chain: Record<string, { txid: string; confirmed: boolean }> = {};
  const indexMisses = new Set<string>();
  const calls = { index: [] as string[][], woc: [] as string[] };
  const deps = (over: Partial<AutoResyncDeps> = {}): AutoResyncDeps => ({
    coins: Object.keys(store).filter((o) => store[o]),
    sats: SATS,
    cleared: {},
    ownPendingTxids: new Set(),
    ownPendingInputs: new Set(),
    getSpends: async (b) => (calls.index.push(b), b.map((o) => (indexMisses.has(o) ? null : (chain[o]?.txid ?? null)))),
    woc: async (o) => (calls.woc.push(o), chain[o] ?? null),
    markSpent: async (o) => (store[o] ? ((store[o] = false), 1) : 0),
    markUnspent: async (o) => (!store[o] ? ((store[o] = true), 1) : 0),
    ...over,
  });
  const balance = () => Object.keys(store).reduce((n, o) => n + (store[o] ? SATS[o] : 0), 0);
  return { store, chain, indexMisses, calls, deps, balance };
}

describe('bigCoins', () => {
  test('largest first until 95% of the value, at most 8', () => {
    expect(bigCoins(Object.keys(SATS), SATS)).toEqual([V4, V1, V0]);
    expect(bigCoins(Object.keys(SATS), SATS, 2)).toEqual([V4, V1]);
    expect(bigCoins(Object.keys(SATS), SATS, 8, 1)).toEqual([V4, V1, V0, V2, V6]);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${T('e')}_${i}`, 100]));
    expect(bigCoins(Object.keys(many), many)).toHaveLength(8);
    expect(bigCoins([V4], {})).toEqual([]);
  });
});

describe('big coins are checked on WhatsOnChain even when the index says unspent', () => {
  test('light run: a big coin the index missed, MINED on WhatsOnChain, is cleared; small coins cost no lookups', async () => {
    const p = phone();
    p.chain[V0] = { txid: SPENDER, confirmed: true };
    p.indexMisses.add(V0);
    const r = await autoResyncCoins({ ...p.deps(), mode: 'light' });
    expect(r.released).toBe(1);
    expect(p.store[V0]).toBe(false);
    expect(p.calls.woc.sort()).toEqual([V0, V1, V4].sort());
  });
  test('…but a mempool spend seen by WhatsOnChain alone never clears it (the two-source rule)', async () => {
    const p = phone();
    p.chain[V0] = { txid: SPENDER, confirmed: false };
    p.indexMisses.add(V0);
    const r = await autoResyncCoins({ ...p.deps(), mode: 'light' });
    expect(r.released).toBe(0);
    expect(p.store[V0]).toBe(true);
  });
  test('the index down: a big coin is still cleared on a mined WhatsOnChain spend', async () => {
    const p = phone();
    p.chain[V4] = { txid: SPENDER, confirmed: true };
    const r = await autoResyncCoins({
      ...p.deps({ getSpends: async () => Promise.reject(new Error('503')) }),
      mode: 'light',
    });
    expect(r.released).toBe(1);
    expect(p.store[V4]).toBe(false);
  });
  test('without values (older callers) a light run is unchanged: no WhatsOnChain for index-unspent coins', async () => {
    const p = phone();
    await autoResyncCoins({ ...p.deps({ sats: undefined }), light: true });
    expect(p.calls.woc).toEqual([]);
  });
});

describe('foreground run (the app came to the front)', () => {
  test('only the biggest coins, both sources each, and no undo pass', async () => {
    const p = phone();
    p.chain[V0] = { txid: SPENDER, confirmed: false }; // the extension's 14:04 spend, mempool, the index has it
    p.chain[V4] = { txid: T('f'), confirmed: false };
    p.chain[V1] = { txid: T('f'), confirmed: false };
    const r = await autoResyncCoins({ ...p.deps({ cleared: { [V6]: SPENDER } }), mode: 'foreground' });
    expect(p.calls.index).toEqual([[V4, V1, V0]]);
    expect(p.calls.woc).toEqual([V4, V1, V0]);
    expect(r.released).toBe(3);
    expect(p.balance()).toBe(SATS[V2] + SATS[V6]); // ~$0.16, the truth
    expect(r.cleared[V6]).toBe(SPENDER); // not re-checked here
  });
  test('throttle: at most once a minute, only when asked, and never instead of a due light/full run', () => {
    const s = { at: 0, lightAt: 0 };
    expect(autoResyncMode(s, 2 * MIN)).toBeNull();
    expect(autoResyncMode(s, 2 * MIN, { foreground: true })).toBe('foreground');
    expect(autoResyncMode({ ...s, fgAt: 2 * MIN }, 2 * MIN + 30_000, { foreground: true })).toBeNull();
    expect(autoResyncMode({ ...s, fgAt: 2 * MIN }, 2 * MIN + AUTO_RESYNC_FOREGROUND_GAP_MS, { foreground: true })).toBe(
      'foreground',
    );
    expect(autoResyncMode(s, AUTO_RESYNC_LIGHT_GAP_MS, { foreground: true })).toBe('light');
    expect(autoResyncMode({}, 0, { foreground: true })).toBe('full');
  });
  test('runAutoResyncIfDue: the extension spends, the phone comes to the front 2 minutes later, the balance drops', async () => {
    const p = phone();
    const m: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: m[k] }),
      set: async (i: Record<string, unknown>) => void Object.assign(m, i),
    };
    await runAutoResyncIfDue('k', kv, async (c) => p.deps({ cleared: c }), 0); // unlock: full run
    p.chain[V0] = { txid: SPENDER, confirmed: false }; // 14:04, the extension
    // A timer tick 2 minutes later: not due.
    expect(await runAutoResyncIfDue('k', kv, async (c) => p.deps({ cleared: c }), 2 * MIN)).toBeNull();
    // The app comes to the front: the big coins are checked at once.
    const r = await runAutoResyncIfDue('k', kv, async (c) => p.deps({ cleared: c }), 2 * MIN, { foreground: true });
    expect(r?.released).toBe(1);
    expect(p.store[V0]).toBe(false);
    expect((m[AUTO_RESYNC_KEY] as AutoResyncState).k.fgAt).toBe(2 * MIN);
    // Back again 20 s later: throttled, no lookups.
    const before = p.calls.woc.length;
    expect(
      await runAutoResyncIfDue('k', kv, async (c) => p.deps({ cleared: c }), 2 * MIN + 20_000, { foreground: true }),
    ).toBeNull();
    expect(p.calls.woc.length).toBe(before);
  });
});

describe('coins the send check cleared are kept for the re-check', () => {
  test('recordAutoCleared adds to the list; a run that started earlier does not drop them', async () => {
    const p = phone();
    const m: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: m[k] }),
      set: async (i: Record<string, unknown>) => void Object.assign(m, i),
    };
    await recordAutoCleared(kv, 'k', { [V1]: SPENDER });
    expect((m[AUTO_RESYNC_KEY] as AutoResyncState).k.cleared).toEqual({ [V1]: SPENDER });
    // A full run loads the list, and the send check clears another coin while it runs.
    const r = await runAutoResyncIfDue(
      'k',
      kv,
      async (c) => {
        await recordAutoCleared(kv, 'k', { [V0]: T('e') });
        return p.deps({ cleared: c });
      },
      0,
    );
    expect(r).not.toBeNull();
    expect((m[AUTO_RESYNC_KEY] as AutoResyncState).k.cleared?.[V0]).toBe(T('e'));
  });
  test('recordAutoCleared never throws', async () => {
    const bad = { get: async () => Promise.reject(new Error('quota')), set: async () => undefined };
    await recordAutoCleared(bad as never, 'k', { [V1]: SPENDER });
  });
});

describe('17b L3: a failed undo keeps the record', () => {
  test('markUnspent throws: the coin stays on the list for the next run; a clean restore ends it', async () => {
    const p = phone();
    p.store[V1] = false;
    const fails = await autoResyncCoins({
      ...p.deps({ cleared: { [V1]: SPENDER }, markUnspent: async () => Promise.reject(new Error('storage busy')) }),
      mode: 'light',
    });
    expect(fails.restored).toBe(0);
    expect(fails.cleared[V1]).toBe(SPENDER);
    const ok = await autoResyncCoins({ ...p.deps({ cleared: fails.cleared }), mode: 'light' });
    expect(ok.restored).toBe(1);
    expect(ok.cleared[V1]).toBeUndefined();
    expect(p.store[V1]).toBe(true);
  });
});
