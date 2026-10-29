import { describe, expect, test } from 'bun:test';
import {
  AUTO_RESYNC_LIGHT_GAP_MS,
  autoResyncCoins,
  autoResyncMode,
  runAutoResyncIfDue,
  type AutoResyncDeps,
} from './autoCoinResync';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const SPENDER = 'd'.repeat(64);
const OWN = 'e'.repeat(64);
const MIN = 60_000;

/**
 * Two devices, one seed (owner, 29 Oct 2026: phone $3.47 vs extension $1.95 until REFRESH WALLET). The phone's
 * store keeps listing a coin the extension spent; the chain (1sat index + WhatsOnChain) knows it is spent.
 */
const phone = () => {
  const store: Record<string, { sats: number; spendable: boolean }> = {
    [`${A}_0`]: { sats: 152_000, spendable: true },
    [`${B}_1`]: { sats: 195_000, spendable: true },
  };
  const chainSpent: Record<string, string> = {};
  const calls = { index: 0, woc: 0 };
  const balance = () => Object.values(store).reduce((n, c) => n + (c.spendable ? c.sats : 0), 0);
  const deps = (cleared: Record<string, string>, pending: Partial<AutoResyncDeps> = {}): AutoResyncDeps => ({
    coins: Object.entries(store)
      .filter(([, c]) => c.spendable)
      .map(([o]) => o),
    cleared,
    ownPendingTxids: new Set(),
    ownPendingInputs: new Set(),
    getSpends: async (b) => (calls.index++, b.map((o) => chainSpent[o] ?? null)),
    woc: async (o) => (calls.woc++, chainSpent[o] ? { txid: chainSpent[o], confirmed: false } : null),
    markSpent: async (o) => (store[o]?.spendable ? ((store[o].spendable = false), 1) : 0),
    markUnspent: async (o) => (store[o] && !store[o].spendable ? ((store[o].spendable = true), 1) : 0),
    ...pending,
  });
  const m: Record<string, unknown> = {};
  const kv = {
    get: async (k: string) => ({ [k]: m[k] }),
    set: async (i: Record<string, unknown>) => void Object.assign(m, i),
  };
  return { store, chainSpent, calls, balance, deps, kv };
};

describe('spent elsewhere → balance drops automatically', () => {
  test('a coin spent by the extension after unlock leaves the phone balance at the next timer/foreground check', async () => {
    const p = phone();
    // Unlock at t=0: full check, nothing spent yet.
    await runAutoResyncIfDue('k', p.kv, async (c) => p.deps(c), 0);
    expect(p.balance()).toBe(347_000);
    // t=1 min: the extension spends coin A. The phone (never relocked) still counts it.
    p.chainSpent[`${A}_0`] = SPENDER;
    // t=2 min: foreground again, too soon: no network.
    const before = { ...p.calls };
    expect(await runAutoResyncIfDue('k', p.kv, async (c) => p.deps(c), 2 * MIN)).toBeNull();
    expect(p.calls).toEqual(before);
    expect(p.balance()).toBe(347_000);
    // t=5 min: timer/foreground light check: balance drops by itself, no REFRESH WALLET.
    const r = await runAutoResyncIfDue('k', p.kv, async (c) => p.deps(c), AUTO_RESYNC_LIGHT_GAP_MS);
    expect(r?.released).toBe(1);
    expect(p.balance()).toBe(195_000);
  });

  test('light check: one batched index call, WhatsOnChain only for the coin the index calls spent', async () => {
    const p = phone();
    p.chainSpent[`${A}_0`] = SPENDER;
    const r = await autoResyncCoins({ ...p.deps({}), light: true });
    expect(r.released).toBe(1);
    expect(p.calls).toEqual({ index: 1, woc: 1 });
  });

  test("coins held by the wallet's own unfinished action are never cleared", async () => {
    const p = phone();
    p.chainSpent[`${A}_0`] = OWN;
    const r = await autoResyncCoins({
      ...p.deps({}, { ownPendingTxids: new Set([OWN]), ownPendingInputs: new Set([`${A}_0`]) }),
      light: true,
    });
    expect(r.released).toBe(0);
    expect(p.balance()).toBe(347_000);
  });

  test('mode: full when never run or 30 min old, light after 5 min, else none', () => {
    expect(autoResyncMode(undefined, 0)).toBe('full');
    expect(autoResyncMode({ at: 0 }, 4 * MIN)).toBeNull();
    expect(autoResyncMode({ at: 0 }, 5 * MIN)).toBe('light');
    expect(autoResyncMode({ at: 0, lightAt: 5 * MIN }, 9 * MIN)).toBeNull();
    expect(autoResyncMode({ at: 0, lightAt: 25 * MIN }, 30 * MIN)).toBe('full');
  });
});
