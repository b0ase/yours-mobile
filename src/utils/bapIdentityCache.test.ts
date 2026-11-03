import { describe, expect, test } from 'bun:test';
import type { OneSatContext, ProfileResponse } from '@1sat/actions';
import { clearBapIdentityCache, loadBapIdentity } from './bapIdentityCache';

const ctx = {} as OneSatContext;

const loader = (opts: { identity?: string; profile?: () => ProfileResponse } = {}) => {
  const calls = { resolve: 0, profile: 0 };
  return {
    calls,
    l: {
      computeBapId: async () => 'bap1',
      resolveBapId: async () => {
        calls.resolve++;
        return 'bap1';
      },
      getProfile: async () => {
        calls.profile++;
        return opts.profile ? opts.profile() : { profile: { name: 'b0ase' } };
      },
      ctxIdentity: async () => opts.identity ?? 'addrA',
    },
  };
};

describe('BAP identity: once per session per identity', () => {
  test('concurrent and later callers share one load; force reloads', async () => {
    clearBapIdentityCache();
    const { l, calls } = loader();
    const [a, b] = await Promise.all([loadBapIdentity(ctx, 'addrA', {}, l), loadBapIdentity(ctx, 'addrA', {}, l)]);
    expect(a).toEqual(b);
    expect(a.profile?.profile?.name).toBe('b0ase');
    await loadBapIdentity(ctx, 'addrA', {}, l);
    expect(calls).toEqual({ resolve: 1, profile: 1 });
    await loadBapIdentity(ctx, 'addrA', { force: true }, l);
    expect(calls).toEqual({ resolve: 2, profile: 2 });
  });

  test('a different identity loads its own', async () => {
    clearBapIdentityCache();
    const a = loader();
    const b = loader({ identity: 'addrB' });
    await loadBapIdentity(ctx, 'addrA', {}, a.l);
    await loadBapIdentity(ctx, 'addrB', {}, b.l);
    expect(b.calls.resolve).toBe(1);
  });

  test('not kept when the wallet answers as another account (mid switch)', async () => {
    clearBapIdentityCache();
    const { l, calls } = loader({ identity: 'addrA' });
    await loadBapIdentity(ctx, 'addrB', {}, l);
    await loadBapIdentity(ctx, 'addrB', {}, l);
    expect(calls.resolve).toBe(2);
  });

  test('a transient profile error is not kept; "no profile" is', async () => {
    clearBapIdentityCache();
    const t = loader({ profile: () => ({ error: 'Wallet busy' }) });
    await loadBapIdentity(ctx, 'addrA', {}, t.l);
    await loadBapIdentity(ctx, 'addrA', {}, t.l);
    expect(t.calls.profile).toBe(2);
    clearBapIdentityCache();
    const n = loader({ profile: () => ({ error: 'no-profile: no alias output in wallet' }) });
    await loadBapIdentity(ctx, 'addrA', {}, n.l);
    await loadBapIdentity(ctx, 'addrA', {}, n.l);
    expect(n.calls.profile).toBe(1);
  });

  test('a lock (clear) forgets it', async () => {
    clearBapIdentityCache();
    const { l, calls } = loader();
    await loadBapIdentity(ctx, 'addrA', {}, l);
    clearBapIdentityCache();
    await loadBapIdentity(ctx, 'addrA', {}, l);
    expect(calls.resolve).toBe(2);
  });
});
