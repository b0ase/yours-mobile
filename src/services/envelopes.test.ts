/**
 * Envelopes (owner, 24 Oct 2026): a site spends only from its own envelope, only up to the balance, atomically, and
 * Coin return releases what is left at once. Old stored allowances grant nothing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { InMemoryPermissionStore, LocalWalletPermissionsManager, normalizeOriginator } from '@1sat/wallet';
import {
  EnvelopeStore,
  chromeEnvelopeBackend,
  closeEnvelopeInAccounts,
  ENVELOPE_LOCK_UNAVAILABLE,
  ENVELOPE_TIMED_OUT,
  EnvelopeUnavailableError,
  requireSharedEnvelopeLock,
  fillEnvelope,
  guardEnvelopes,
  isMicropaymentSite,
  markMicropayments,
  MAX_ENVELOPE_SATS,
  parseEnvelopeState,
  returnCoins,
  spendFromEnvelope,
  emptyEnvelopeState,
  type EnvelopeBackend,
  type EnvelopeState,
} from './envelopes';

/** A backend with an await on every read and write, so interleavings are real. */
const memBackend = (): EnvelopeBackend & { raw: () => unknown } => {
  let data: unknown;
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 2));
  return {
    load: async () => {
      await tick();
      return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    },
    save: async (s: EnvelopeState) => {
      await tick();
      data = JSON.parse(JSON.stringify(s));
    },
    raw: () => data,
  };
};

const A = 'arcade.example';
const B = 'other.example';

describe('envelope model', () => {
  test('fill, spend all-or-nothing, never negative', () => {
    let s = fillEnvelope(emptyEnvelopeState(), A, 1000, 1).state;
    expect(s.envelopes[A].balanceSats).toBe(1000);
    const over = spendFromEnvelope(s, A, 1001, 2);
    expect(over.ok).toBe(false);
    expect(over.state).toBe(s);
    const ok = spendFromEnvelope(s, A, 1000, 3);
    expect(ok.ok).toBe(true);
    s = ok.state;
    expect(s.envelopes[A].balanceSats).toBe(0);
    expect(spendFromEnvelope(s, A, 1, 4).ok).toBe(false);
    expect(s.envelopes[A].history.map((h) => h.kind)).toEqual(['fill', 'spend']);
  });

  test('zero, negative, NaN and fractional spends', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, 10, 1).state;
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(spendFromEnvelope(s, A, bad, 2).ok).toBe(false);
    // A fraction is rounded up, so 9.5 takes 10 and 10.5 does not fit.
    expect(spendFromEnvelope(s, A, 9.5, 2).balanceSats).toBe(0);
    expect(spendFromEnvelope(s, A, 10.5, 2).ok).toBe(false);
  });

  test('a fill is capped and junk fills add nothing', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, MAX_ENVELOPE_SATS * 3, 1).state;
    expect(s.envelopes[A].balanceSats).toBe(MAX_ENVELOPE_SATS);
    expect(fillEnvelope(s, A, 5, 2).added).toBe(0);
    expect(fillEnvelope(emptyEnvelopeState(), A, -5, 1).added).toBe(0);
    expect(fillEnvelope(emptyEnvelopeState(), '', 5, 1).added).toBe(0);
  });

  test('coin return releases the whole balance and removes the envelope', () => {
    const s = fillEnvelope(emptyEnvelopeState(), A, 700, 1).state;
    const r = returnCoins(s, A);
    expect(r.returned).toBe(700);
    expect(r.state.envelopes[A]).toBeUndefined();
    expect(spendFromEnvelope(r.state, A, 1, 2).ok).toBe(false);
    expect(returnCoins(r.state, A).returned).toBe(0);
  });

  test('stored junk grants nothing', () => {
    const s = parseEnvelopeState({
      envelopes: {
        [A]: { originator: A, balanceSats: -100 },
        [B]: { originator: 'evil.example', balanceSats: 100 },
        'c.example': { originator: 'c.example', balanceSats: '100' },
        'd.example': { originator: 'd.example', balanceSats: 50 },
      },
    });
    expect(Object.keys(s.envelopes)).toEqual(['d.example']);
    expect(parseEnvelopeState(null).envelopes).toEqual({});
    expect(parseEnvelopeState('x').envelopes).toEqual({});
  });
});

describe('envelope store', () => {
  test('concurrent spends never take more than the balance (no double spend)', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 255);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.trySpend(A, 10)));
    expect(results.filter(Boolean).length).toBe(25);
    expect((await store.get(A))?.balanceSats).toBe(5);
    expect((await store.get(A))?.spentSats).toBe(250);
  });

  test('two payments racing for the last balance: exactly one wins', async () => {
    for (let i = 0; i < 20; i++) {
      const store = new EnvelopeStore(memBackend());
      await store.fill(A, 100);
      const [x, y] = await Promise.all([store.trySpend(A, 100), store.trySpend(A, 100)]);
      expect(Number(x) + Number(y)).toBe(1);
      expect((await store.get(A))?.balanceSats).toBe(0);
    }
  });

  test('coin return racing payments: nothing is spent after the return, balance never negative', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 1000);
    const ops = [
      ...Array.from({ length: 5 }, () => store.trySpend(A, 100)),
      store.close(A),
      ...Array.from({ length: 5 }, () => store.trySpend(A, 100)),
    ];
    const out = await Promise.all(ops);
    const spent = (out.slice(0, 5) as boolean[]).filter(Boolean).length;
    expect(spent).toBe(5);
    expect(out[5]).toBe(500);
    expect((out.slice(6) as boolean[]).some(Boolean)).toBe(false);
    expect(await store.get(A)).toBeUndefined();
  });

  test('another site cannot spend, see or close the envelope', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(A, 500);
    expect(await store.trySpend(B, 1)).toBe(false);
    expect(await store.get(B)).toBeUndefined();
    expect(await store.close(B)).toBe(0);
    expect((await store.get(A))?.balanceSats).toBe(500);
  });

  test('a failed save changes nothing and the queue keeps working', async () => {
    const be = memBackend();
    const store = new EnvelopeStore(be);
    await store.fill(A, 100);
    const save = be.save;
    be.save = async () => {
      throw new Error('disk full');
    };
    await expect(store.trySpend(A, 50)).rejects.toThrow('disk full');
    be.save = save;
    expect((await store.get(A))?.balanceSats).toBe(100);
    expect(await store.trySpend(A, 50)).toBe(true);
  });
});

/** A permissions manager stand-in: `ensureSpendingAuthorization` approves as an old stored allowance would. */
const fakeManager = () => {
  const flowCalls: { originator: string; spending: { satoshis: number } }[] = [];
  const originalCalls: unknown[] = [];
  const m = {
    ensureSpendingAuthorization: async (a: unknown) => {
      originalCalls.push(a);
      return true;
    },
    requestPermissionFlow: async (r: { originator: string; spending: { satoshis: number } }) => {
      flowCalls.push(r);
      return false;
    },
  };
  return { m, flowCalls, originalCalls };
};

describe('guardEnvelopes', () => {
  const setup = async (balance = 500) => {
    const store = new EnvelopeStore(memBackend());
    if (balance) await store.fill(normalizeOriginator(A), balance);
    const f = fakeManager();
    const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
    const pay = (originator: string, satoshis: number, seekPermission?: boolean) =>
      g.ensureSpendingAuthorization({ originator, satoshis, seekPermission } as never);
    return { store, pay, ...f };
  };

  test('a payment under the balance goes through without a sheet and ticks the balance down', async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await pay(A, 400)).toBe(true);
    expect(flowCalls.length).toBe(0);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(100);
  });

  test('a payment over the balance shows the pay sheet and leaves the envelope alone', async () => {
    const { pay, flowCalls, originalCalls, store } = await setup(500);
    expect(await pay(A, 600)).toBe(false);
    expect(flowCalls).toHaveLength(1);
    expect(flowCalls[0].spending.satoshis).toBe(600);
    // The original method (which honours stored allowances) is never asked.
    expect(originalCalls).toHaveLength(0);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(500);
  });

  test('no silent spend beyond the balance, however it is split', async () => {
    const { pay, flowCalls, store } = await setup(1000);
    const silent = (await Promise.all(Array.from({ length: 30 }, () => pay(A, 70)))).filter(Boolean).length;
    expect(silent).toBe(14); // 14 × 70 = 980; the rest asked
    expect(flowCalls).toHaveLength(16);
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(20);
  });

  test("another site's payment never uses this envelope", async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await pay(B, 1)).toBe(false);
    expect(flowCalls[0].originator).toBe(normalizeOriginator(B));
    expect((await store.get(normalizeOriginator(A)))?.balanceSats).toBe(500);
  });

  test('after Coin return the site asks again', async () => {
    const { pay, flowCalls, store } = await setup(500);
    expect(await store.close(normalizeOriginator(A))).toBe(500);
    expect(await pay(A, 1)).toBe(false);
    expect(flowCalls).toHaveLength(1);
  });

  test('seekPermission=false over the balance is refused, not approved', async () => {
    const { pay } = await setup(10);
    await expect(pay(A, 11, false)).rejects.toThrow('needs your approval');
  });

  test('the wallet itself and zero spends use the original path', async () => {
    const { pay, originalCalls, flowCalls } = await setup(0);
    expect(await pay('admin', 999)).toBe(true);
    expect(await pay(A, 0)).toBe(true);
    expect(originalCalls).toHaveLength(2);
    expect(flowCalls).toHaveLength(0);
  });
});

describe('no spending caps (owner, 25 Oct 2026)', () => {
  // TokenBlaster credit: ONE createAction for the exact total. 1 USD ≈ 2,000,000 sats at a $50 BSV price.
  for (const [label, satoshis] of [
    ['100 × $1 load', 100 * 2_000_000],
    ['$500 load', 500 * 2_000_000],
  ] as const) {
    test(`${label}: one sheet for the full amount, Approve pays, no stored allowance consulted`, async () => {
      const store = new EnvelopeStore(memBackend());
      const sheets: { originator: string; spending: { satoshis: number } }[] = [];
      const originalCalls: unknown[] = [];
      const m = {
        ensureSpendingAuthorization: async (a: unknown) => {
          originalCalls.push(a);
          return false; // an old allowance that would refuse: must never be asked
        },
        requestPermissionFlow: async (r: { originator: string; spending: { satoshis: number } }) => {
          sheets.push(r);
          return true; // the user taps Approve
        },
      };
      const g = guardEnvelopes(m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
      const ok = await g.ensureSpendingAuthorization({ originator: 'https://www.tokenblaster.lol', satoshis } as never);
      expect(ok).toBe(true);
      expect(sheets).toHaveLength(1);
      expect(sheets[0].spending.satoshis).toBe(satoshis);
      expect(originalCalls).toHaveLength(0);
    });
  }

  test('the approval sheet never says a payment is over an allowance or a site limit', async () => {
    const { readFileSync } = await import('node:fs');
    const sheet = readFileSync(new URL('../pages/requests/BundleSheet.tsx', import.meta.url), 'utf8');
    expect(sheet).not.toMatch(/over your allowance/i);
    expect(sheet).not.toMatch(/may spend/i);
    expect(sheet).not.toMatch(/Your allowance here/i);
  });
});

describe('migration: old monthly allowances grant nothing', () => {
  test('a stored $5/month allowance on the real manager no longer approves silently', async () => {
    const store = new InMemoryPermissionStore();
    await store.putGrant({
      key: { type: 'spending', originator: normalizeOriginator(A) },
      expiry: 0,
      grantedAt: Date.now(),
      authorizedAmount: 5_000_000,
    } as never);
    const w = {
      listActions: async () => ({ actions: [], totalActions: 0 }),
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
    };
    const envelopes = new EnvelopeStore(memBackend());
    const mgr = guardEnvelopes(new LocalWalletPermissionsManager(w as never, 'admin', {}, { store } as never), {
      envelopes,
      adminOriginator: 'admin',
      normalize: normalizeOriginator,
    });
    const pay = (satoshis: number) =>
      mgr.ensureSpendingAuthorization({ originator: A, satoshis, reason: 'pay', seekPermission: false } as never).then(
        () => 'auto',
        () => 'asks',
      );
    // Without the guard this would be 'auto' (spendLedger.test.ts shows the allowance path).
    expect(await pay(1_000)).toBe('asks');
    await envelopes.fill(normalizeOriginator(A), 2_000);
    expect(await pay(1_000)).toBe('auto');
    expect(await pay(1_500)).toBe('asks');
  });
});

describe('micropayment sites', () => {
  test('a site is flagged while its call names a streaming protocol, then not', () => {
    expect(isMicropaymentSite('tokenblaster.lol')).toBe(true);
    expect(isMicropaymentSite('stream.example')).toBe(false);
    const done = markMicropayments('stream.example');
    expect(isMicropaymentSite('stream.example')).toBe(true);
    done();
    done();
    expect(isMicropaymentSite('stream.example')).toBe(false);
  });
});

describe('b-Aware 24 Oct 2026: envelope keys, accounts and Revoke all', () => {
  test('an envelope for https://shop.com is never spent by https://shop.com:8443 (ports are separate sites)', async () => {
    const store = new EnvelopeStore(memBackend());
    await store.fill(normalizeOriginator('https://shop.com'), 500);
    const f = fakeManager();
    const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: normalizeOriginator });
    expect(await g.ensureSpendingAuthorization({ originator: 'https://shop.com:8443', satoshis: 100 } as never)).toBe(
      false,
    );
    expect(f.flowCalls).toHaveLength(1);
    expect(f.flowCalls[0].originator).toBe(normalizeOriginator('https://shop.com:8443'));
    expect(normalizeOriginator('http://localhost:3001')).not.toBe(normalizeOriginator('http://localhost:3002'));
    expect((await store.get(normalizeOriginator('https://shop.com')))?.balanceSats).toBe(500);
  });

  test('one account never sees or spends another account’s envelope', async () => {
    const backends = new Map<string, ReturnType<typeof memBackend>>();
    const be = (id: string) => backends.get(id) ?? (backends.set(id, memBackend()), backends.get(id)!);
    const a = new EnvelopeStore(be('acctA'));
    const b = new EnvelopeStore(be('acctB'));
    await a.fill(A, 500);
    expect(await b.get(A)).toBeUndefined();
    expect(await b.trySpend(A, 1)).toBe(false);
    expect((await a.get(A))?.balanceSats).toBe(500);
  });

  test('Revoke all across accounts closes the site’s envelope in each, and only that site’s', async () => {
    const backends = new Map<string, ReturnType<typeof memBackend>>();
    const be = (id: string) => backends.get(id) ?? (backends.set(id, memBackend()), backends.get(id)!);
    await new EnvelopeStore(be('x')).fill(A, 300);
    await new EnvelopeStore(be('y')).fill(A, 200);
    await new EnvelopeStore(be('y')).fill(B, 50);
    expect(await closeEnvelopeInAccounts(['x', 'y', 'y', ''], A, be)).toBe(500);
    expect(await new EnvelopeStore(be('x')).get(A)).toBeUndefined();
    expect(await new EnvelopeStore(be('y')).get(A)).toBeUndefined();
    expect((await new EnvelopeStore(be('y')).get(B))?.balanceSats).toBe(50);
  });
});

/**
 * Two backends over ONE stored value, as two EnvelopeStores over the same `bwxEnvelopes:<account>` key are: the store
 * an old wallet keeps and the one a re-init builds (initWallet.ts). Every read and write yields first, so two loads
 * both happen before either save unless something outside the instances serialises them.
 */
const sharedCell = () => {
  let data: unknown;
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  const backend = (key?: string): EnvelopeBackend => ({
    key,
    load: async () => {
      await yieldNow();
      return data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    },
    save: async (s: EnvelopeState) => {
      await yieldNow();
      data = JSON.parse(JSON.stringify(s));
    },
  });
  return { backend, raw: () => data as EnvelopeState | undefined };
};

describe('13 Nov 2026: one envelope lock per storage key, across store instances (wallet re-init)', () => {
  test('two stores over one key racing for the last sats: exactly one payment passes', async () => {
    for (let i = 0; i < 20; i++) {
      const cell = sharedCell();
      const old = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-race'));
      const reinit = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-race'));
      await old.fill(A, 100);
      const [x, y] = await Promise.all([old.trySpend(A, 100), reinit.trySpend(A, 100)]);
      expect(Number(x) + Number(y)).toBe(1);
      expect(cell.raw()?.envelopes[A].balanceSats).toBe(0);
      expect(cell.raw()?.envelopes[A].spentSats).toBe(100);
    }
  });

  test('many payments from three stores over one key never take more than the balance', async () => {
    const cell = sharedCell();
    const stores = [0, 1, 2].map(() => new EnvelopeStore(cell.backend('bwxEnvelopes:acct-many')));
    await stores[0].fill(A, 255);
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => stores[i % 3].trySpend(A, 10)));
    expect(results.filter(Boolean).length).toBe(25);
    expect(cell.raw()?.envelopes[A].balanceSats).toBe(5);
  });

  test('Revoke all (closeEnvelopeInAccounts) racing the live store: nothing is both spent and returned', async () => {
    for (let i = 0; i < 10; i++) {
      const cell = sharedCell();
      const live = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-close'));
      await live.fill(A, 100);
      const [spent, returned] = await Promise.all([
        live.trySpend(A, 100),
        closeEnvelopeInAccounts(['acct-close'], A, () => cell.backend('bwxEnvelopes:acct-close')),
      ]);
      expect((spent ? 100 : 0) + returned).toBe(100);
      // Whichever ran second sees the first: no envelope is left behind with a balance.
      expect(cell.raw()?.envelopes[A]?.balanceSats ?? 0).toBe(0);
    }
  });

  test('stores over different keys do not wait for each other', async () => {
    const a = sharedCell();
    const b = sharedCell();
    const sa = new EnvelopeStore(a.backend('bwxEnvelopes:acct-1'));
    const sb = new EnvelopeStore(b.backend('bwxEnvelopes:acct-2'));
    await sa.fill(A, 100);
    await sb.fill(A, 100);
    expect(await Promise.all([sa.trySpend(A, 100), sb.trySpend(A, 100)])).toEqual([true, true]);
  });

  test('with navigator.locks (extension worker, web tabs): the lock is named by the storage key and serialises', async () => {
    const names: string[] = [];
    const tails = new Map<string, Promise<unknown>>();
    const locks = {
      request: <T>(name: string, _o: object, cb: () => Promise<T>): Promise<T> => {
        names.push(name);
        const run = (tails.get(name) ?? Promise.resolve()).then(cb, cb);
        tails.set(
          name,
          run.catch(() => undefined),
        );
        return run;
      },
    };
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    Object.defineProperty(nav, 'locks', { value: locks, configurable: true });
    try {
      const cell = sharedCell();
      const s1 = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-locks'));
      const s2 = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-locks'));
      await s1.fill(A, 100);
      const [x, y] = await Promise.all([s1.trySpend(A, 100), s2.trySpend(A, 100)]);
      expect(Number(x) + Number(y)).toBe(1);
      expect(new Set(names)).toEqual(new Set(['bwx-envelopes:bwxEnvelopes:acct-locks']));
    } finally {
      delete nav.locks;
    }
  });

  test('a lock that cannot be taken refuses the payment (fail closed), it never runs unlocked', async () => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    Object.defineProperty(nav, 'locks', {
      value: { request: () => Promise.reject(new Error('locks unavailable')) },
      configurable: true,
    });
    try {
      const cell = sharedCell();
      const store = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-nolock'));
      await expect(store.trySpend(A, 1)).rejects.toThrow('locks unavailable');
      const f = fakeManager();
      const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: (o) => o });
      await expect(g.ensureSpendingAuthorization({ originator: A, satoshis: 1 } as never)).rejects.toThrow();
      expect(f.flowCalls).toHaveLength(0);
    } finally {
      delete nav.locks;
    }
  });

  test('chromeEnvelopeBackend: carries its key, and a failed read refuses the spend and saves nothing', async () => {
    const g = globalThis as unknown as { chrome?: unknown };
    const before = g.chrome;
    let sets = 0;
    const runtime: { lastError?: { message: string } } = {};
    g.chrome = {
      runtime,
      storage: {
        local: {
          get: (_k: string, cb: (v: unknown) => void) => {
            runtime.lastError = { message: 'storage read failed' };
            try {
              cb(undefined);
            } finally {
              runtime.lastError = undefined;
            }
          },
          set: (_v: unknown, cb: () => void) => {
            sets++;
            cb();
          },
        },
      },
    };
    try {
      const be = chromeEnvelopeBackend('acct-chrome');
      expect(be.key).toBe('bwxEnvelopes:acct-chrome');
      const store = new EnvelopeStore(be);
      await expect(store.trySpend(A, 1)).rejects.toThrow('storage read failed');
      await expect(store.fill(A, 100)).rejects.toThrow('storage read failed');
      await expect(store.close(A)).rejects.toThrow('storage read failed');
      expect(sets).toBe(0);
    } finally {
      g.chrome = before;
    }
  });

  test('web wallet without Web Locks: every envelope operation is refused, never run on a tab-only queue', async () => {
    requireSharedEnvelopeLock();
    try {
      const cell = sharedCell();
      const store = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-web'));
      await expect(store.fill(A, 100)).rejects.toThrow(ENVELOPE_LOCK_UNAVAILABLE);
      await expect(store.trySpend(A, 1)).rejects.toThrow(ENVELOPE_LOCK_UNAVAILABLE);
      expect(cell.raw()).toBeUndefined();
    } finally {
      requireSharedEnvelopeLock(false);
    }
  });

  test('main.ts asks web workers (not phones or Desktop) for the shared envelope lock', () => {
    const main = readFileSync(new URL('../mobile/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('sharedEnvelopeLock: !Capacitor.isNativePlatform() && !IS_TAURI');
    const worker = readFileSync(new URL('../mobile/background.worker.ts', import.meta.url), 'utf8');
    expect(worker).toContain("if (sharedEnvelopeLock) (await import('../services/envelopes')).requireSharedEnvelopeLock();");
  });
});

/** A backend over a shared cell whose next load or save can be made to hang (never answer). */
const hangable = (cell: ReturnType<typeof sharedCell>, key: string) => {
  const inner = cell.backend(key);
  const ctl = { hangLoad: false, hangSave: false, saves: 0 };
  const never = new Promise<never>(() => {});
  const backend: EnvelopeBackend = {
    key,
    load: () => (ctl.hangLoad ? never : inner.load()),
    save: (st) => {
      ctl.saves++;
      return ctl.hangSave ? never : inner.save(st);
    },
  };
  return { backend, ctl };
};

describe('review of fix/envelope-queue (13 Nov 2026): deadlines, carrying on, falling back to the sheet', () => {
  test('F1: a read that never answers is refused at the deadline and gives the lock up', async () => {
    const cell = sharedCell();
    const h = hangable(cell, 'bwxEnvelopes:acct-hang-read');
    const store = new EnvelopeStore(h.backend, Date.now, { timeoutMs: 50 });
    await store.fill(A, 100);
    h.ctl.hangLoad = true;
    await expect(store.trySpend(A, 100)).rejects.toThrow(ENVELOPE_TIMED_OUT);
    h.ctl.hangLoad = false;
    // Nothing was written, the lock is free: the next op reads fresh state and runs.
    expect(await store.trySpend(A, 100)).toBe(true);
    expect(cell.raw()?.envelopes[A].balanceSats).toBe(0);
  });

  test('F1: a write that never answers keeps the lock (no unlocked read around it); later ops time out, never hang', async () => {
    const cell = sharedCell();
    const h = hangable(cell, 'bwxEnvelopes:acct-hang-write');
    const store = new EnvelopeStore(h.backend, Date.now, { timeoutMs: 50 });
    const other = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-hang-write'), Date.now, { timeoutMs: 50 });
    await store.fill(A, 100);
    h.ctl.hangSave = true;
    const first = store.trySpend(A, 100);
    await expect(first).rejects.toBeInstanceOf(EnvelopeUnavailableError);
    // The other store would read the old 100 if it could get in: it can't, it is told "unavailable" instead.
    await expect(other.trySpend(A, 100)).rejects.toThrow(ENVELOPE_TIMED_OUT);
    expect(cell.raw()?.envelopes[A].balanceSats).toBe(100);
  });

  test('F1: an op that timed out while waiting for the lock never runs later (nothing written after "no")', async () => {
    const cell = sharedCell();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: EnvelopeBackend = {
      key: 'bwxEnvelopes:acct-late',
      load: async () => {
        await gate;
        return cell.raw();
      },
      save: (st) => cell.backend().save(st),
    };
    await new EnvelopeStore(cell.backend('bwxEnvelopes:acct-late')).fill(A, 100);
    const holder = new EnvelopeStore(slow, Date.now, { timeoutMs: 10_000 }).get(A); // holds the lock
    const waiter = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-late'), Date.now, { timeoutMs: 30 });
    await expect(waiter.trySpend(A, 100)).rejects.toThrow(ENVELOPE_TIMED_OUT);
    release();
    await holder;
    await new Promise((r) => setTimeout(r, 20));
    expect(cell.raw()?.envelopes[A].balanceSats).toBe(100);
  });

  test('F4: lock unavailable on the web → the normal sheet for this payment, never an unlocked spend', async () => {
    requireSharedEnvelopeLock();
    try {
      const cell = sharedCell();
      const store = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-f4'));
      const f = fakeManager();
      const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: (o) => o });
      expect(await g.ensureSpendingAuthorization({ originator: A, satoshis: 10 } as never)).toBe(false);
      expect(f.flowCalls).toHaveLength(1);
      expect(f.flowCalls[0].spending.satoshis).toBe(10);
      await expect(
        g.ensureSpendingAuthorization({ originator: A, satoshis: 10, seekPermission: false } as never),
      ).rejects.toThrow('needs your approval');
      expect(cell.raw()).toBeUndefined();
    } finally {
      requireSharedEnvelopeLock(false);
    }
  });

  test('F4: an envelope that does not answer in time also falls back to the sheet', async () => {
    const cell = sharedCell();
    const h = hangable(cell, 'bwxEnvelopes:acct-f4-timeout');
    const store = new EnvelopeStore(h.backend, Date.now, { timeoutMs: 30 });
    await store.fill(A, 100);
    h.ctl.hangLoad = true;
    const f = fakeManager();
    const g = guardEnvelopes(f.m, { envelopes: store, adminOriginator: 'admin', normalize: (o) => o });
    expect(await g.ensureSpendingAuthorization({ originator: A, satoshis: 10 } as never)).toBe(false);
    expect(f.flowCalls).toHaveLength(1);
    expect(cell.raw()?.envelopes[A].balanceSats).toBe(100);
  });

  test('F2: Revoke all closes every account it can, then reports the one it could not', async () => {
    const backends = new Map<string, EnvelopeBackend>();
    const be = (id: string): EnvelopeBackend =>
      id === 'broken'
        ? { key: 'bwxEnvelopes:broken', load: async () => Promise.reject(new Error('read failed')), save: async () => {} }
        : backends.get(id) ?? (backends.set(id, memBackend()), backends.get(id)!);
    await new EnvelopeStore(be('x2')).fill(A, 300);
    await new EnvelopeStore(be('z2')).fill(A, 200);
    await expect(closeEnvelopeInAccounts(['x2', 'broken', 'z2'], A, be)).rejects.toThrow('1 account(s): read failed');
    expect(await new EnvelopeStore(be('x2')).get(A)).toBeUndefined();
    expect(await new EnvelopeStore(be('z2')).get(A)).toBeUndefined();
  });

  test('re-review: on a browser without Web Locks, Coin return / Revoke all still close the envelope; fill and spend stay refused', async () => {
    requireSharedEnvelopeLock();
    const cell = sharedCell();
    try {
      requireSharedEnvelopeLock(false);
      await new EnvelopeStore(cell.backend('bwxEnvelopes:acct-nolock-close')).fill(A, 100);
      requireSharedEnvelopeLock();
      const store = new EnvelopeStore(cell.backend('bwxEnvelopes:acct-nolock-close'));
      await expect(store.trySpend(A, 1)).rejects.toThrow(ENVELOPE_LOCK_UNAVAILABLE);
      await expect(store.fill(A, 1)).rejects.toThrow(ENVELOPE_LOCK_UNAVAILABLE);
      expect(
        await closeEnvelopeInAccounts(['acct-nolock-close'], A, () => cell.backend('bwxEnvelopes:acct-nolock-close')),
      ).toBe(100);
      expect(cell.raw()?.envelopes[A]).toBeUndefined();
    } finally {
      requireSharedEnvelopeLock(false);
    }
  });

  test('N3: while a write is stuck past its deadline, this process refuses the key at once (no 15 s wait each time)', async () => {
    const cell = sharedCell();
    const key = 'bwxEnvelopes:acct-stuck';
    let finish!: () => void;
    const stuck: EnvelopeBackend = {
      key,
      load: () => cell.backend(key).load(),
      save: (st) => new Promise<void>((r) => (finish = () => void cell.backend(key).save(st).then(r))),
    };
    await new EnvelopeStore(cell.backend(key)).fill(A, 100);
    const timeoutMs = 60;
    const first = new EnvelopeStore(stuck, Date.now, { timeoutMs }).trySpend(A, 10);
    await expect(first).rejects.toBeInstanceOf(EnvelopeUnavailableError);
    await new Promise((r) => setTimeout(r, timeoutMs));
    const t0 = Date.now();
    await expect(new EnvelopeStore(cell.backend(key), Date.now, { timeoutMs: 5_000 }).get(A)).rejects.toThrow(
      ENVELOPE_TIMED_OUT,
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    finish();
    await new Promise((r) => setTimeout(r, 20));
    // Settled: the key works again and reads the write that landed.
    expect((await new EnvelopeStore(cell.backend(key)).get(A))?.balanceSats).toBe(90);
  });
});

