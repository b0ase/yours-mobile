import { describe, expect, test } from 'bun:test';
import { clearWalletReadCaches, invalidateWalletLists, stableKey, withWalletReadCache } from './walletReadCache';

/** A fake wallet whose identity key is "id:<account>" and derived keys "<account>|<protocol>|<keyID>". */
const fakeWallet = (state: { account: string }) => {
  const calls: Record<string, number> = {};
  const count = (m: string) => (calls[m] = (calls[m] ?? 0) + 1);
  let outputsVersion = 0;
  const wallet = {
    getPublicKey: async (args: { identityKey?: boolean; protocolID?: [number, string]; keyID?: string }) => {
      count('getPublicKey');
      await Promise.resolve();
      return {
        publicKey: args.identityKey ? `id:${state.account}` : `${state.account}|${args.protocolID?.[1]}|${args.keyID}`,
      };
    },
    listOutputs: async (args: { basket: string }) => {
      count('listOutputs');
      await Promise.resolve();
      return { totalOutputs: 1, outputs: [{ outpoint: `${args.basket}.${outputsVersion}`, satoshis: 1 }] };
    },
    createAction: async () => {
      count('createAction');
      outputsVersion++;
      return { txid: 'tx' };
    },
    createSignature: async () => {
      count('createSignature');
      return { signature: [1, 2, 3] };
    },
  };
  return { wallet, calls };
};

const setup = (opts: { ttl?: number } = {}) => {
  const state = { account: 'A', selected: 'A', locked: false };
  let t = 1_000;
  const { wallet, calls } = fakeWallet(state);
  const { wallet: w, control } = withWalletReadCache(wallet, {
    scope: () => (state.locked ? '' : state.selected),
    identityMatches: (pk, scope) => pk === `id:${scope}`,
    listTtlMs: opts.ttl ?? 10_000,
    now: () => t,
  });
  return { state, w, calls, control, advance: (ms: number) => (t += ms) };
};

const P: [0, string] = [0, 'onesat'];

describe('getPublicKey cache', () => {
  test('identical calls in flight share one request, and later calls are answered from memory', async () => {
    const { w, calls } = setup();
    const args = { protocolID: P, keyID: '1sat 3', forSelf: true };
    const [a, b] = await Promise.all([w.getPublicKey(args), w.getPublicKey(args)]);
    expect(a).toEqual(b);
    await w.getPublicKey(args);
    await w.getPublicKey({ forSelf: true, keyID: '1sat 3', protocolID: P }); // same params, other key order
    // One identity check (to prove the account) + one derived key.
    expect(calls.getPublicKey).toBe(2);
  });

  test('different params are different entries', async () => {
    const { w, calls } = setup();
    await w.getPublicKey({ protocolID: P, keyID: '1sat 1', forSelf: true });
    await w.getPublicKey({ protocolID: P, keyID: '1sat 2', forSelf: true });
    await w.getPublicKey({ protocolID: P, keyID: '1sat 2', forSelf: false });
    await w.getPublicKey({ protocolID: P, keyID: '1sat 2', counterparty: 'self' });
    expect(calls.getPublicKey).toBe(1 + 4);
  });

  test('keyed by account: a switch (or lock) starts empty', async () => {
    const { w, state, calls } = setup();
    const args = { protocolID: P, keyID: '1sat 0', forSelf: true };
    expect(await w.getPublicKey(args)).toEqual({ publicKey: 'A|onesat|1sat 0' });
    state.account = 'B';
    state.selected = 'B';
    expect(await w.getPublicKey(args)).toEqual({ publicKey: 'B|onesat|1sat 0' });
    state.locked = true;
    await w.getPublicKey(args);
    await w.getPublicKey(args);
    expect(calls.getPublicKey).toBe(2 + 2 + 2); // A: id+key, B: id+key, locked: no caching
    state.locked = false;
    await w.getPublicKey(args);
    expect(calls.getPublicKey).toBe(6 + 2); // fresh after the lock
  });

  test("never caches another account's answers (background still on the previous account)", async () => {
    const { w, state, calls } = setup();
    state.selected = 'B'; // page already shows B, the wallet still answers as A
    const args = { protocolID: P, keyID: '1sat 0', forSelf: true };
    expect(await w.getPublicKey({ identityKey: true })).toEqual({ publicKey: 'id:A' });
    expect(await w.getPublicKey({ identityKey: true })).toEqual({ publicKey: 'id:A' });
    expect(await w.getPublicKey(args)).toEqual({ publicKey: 'A|onesat|1sat 0' });
    const before = calls.getPublicKey;
    state.account = 'B'; // the wallet finishes switching
    expect(await w.getPublicKey({ identityKey: true })).toEqual({ publicKey: 'id:B' });
    expect(await w.getPublicKey(args)).toEqual({ publicKey: 'B|onesat|1sat 0' });
    expect(calls.getPublicKey).toBe(before + 2);
    await w.getPublicKey(args);
    await w.getPublicKey({ identityKey: true });
    expect(calls.getPublicKey).toBe(before + 2);
  });

  test('a failed call is not cached', async () => {
    const state = { n: 0 };
    const { wallet } = withWalletReadCache(
      {
        getPublicKey: async (a: { identityKey?: boolean }) => {
          if (a.identityKey) return { publicKey: 'id:A' };
          if (state.n++ === 0) throw new Error('busy');
          return { publicKey: 'k' };
        },
      },
      { scope: () => 'A', identityMatches: (pk, s) => pk === `id:${s}` },
    );
    await expect(wallet.getPublicKey({ keyID: 'x' })).rejects.toThrow('busy');
    expect(await wallet.getPublicKey({ keyID: 'x' })).toEqual({ publicKey: 'k' });
  });

  test('private operations pass straight through', async () => {
    const { w, calls } = setup();
    await w.createSignature();
    await w.createSignature();
    expect(calls.createSignature).toBe(2);
  });
});

describe('listOutputs dedupe', () => {
  const args = { basket: 'lock', limit: 10000 };

  test('identical calls in flight share one request; answers are reused for the TTL', async () => {
    const { w, calls, advance } = setup();
    const [a, b] = await Promise.all([w.listOutputs(args), w.listOutputs({ limit: 10000, basket: 'lock' })]);
    expect(a).toEqual(b);
    await w.listOutputs(args);
    expect(calls.listOutputs).toBe(1);
    advance(9_999);
    await w.listOutputs(args);
    expect(calls.listOutputs).toBe(1);
    advance(2);
    await w.listOutputs(args);
    expect(calls.listOutputs).toBe(2);
  });

  test('each caller gets its own outputs array (one sorting in place cannot affect another)', async () => {
    const { w } = setup();
    const a = (await w.listOutputs(args)) as { outputs: unknown[] };
    a.outputs.length = 0;
    const b = (await w.listOutputs(args)) as { outputs: unknown[] };
    expect(b.outputs.length).toBe(1);
  });

  test('a write (createAction) invalidates cached lists', async () => {
    const { w, calls } = setup();
    expect(((await w.listOutputs(args)) as { outputs: { outpoint: string }[] }).outputs[0].outpoint).toBe('lock.0');
    await w.createAction();
    expect(((await w.listOutputs(args)) as { outputs: { outpoint: string }[] }).outputs[0].outpoint).toBe('lock.1');
    expect(calls.listOutputs).toBe(2);
  });

  test('invalidateWalletLists / clearWalletReadCaches drop lists', async () => {
    const { w, calls } = setup();
    await w.listOutputs(args);
    invalidateWalletLists();
    await w.listOutputs(args);
    clearWalletReadCaches();
    await w.listOutputs(args);
    expect(calls.listOutputs).toBe(3);
  });

  test('calls with any non-read argument are never cached', async () => {
    const { w, calls } = setup();
    const reserve = { basket: 'lock', reserve: true } as unknown as typeof args;
    await w.listOutputs(reserve);
    await w.listOutputs(reserve);
    expect(calls.listOutputs).toBe(2);
  });

  test('keyed by account', async () => {
    const { w, state, calls } = setup();
    await w.listOutputs(args);
    state.account = 'B';
    state.selected = 'B';
    await w.listOutputs(args);
    expect(calls.listOutputs).toBe(2);
  });
});

test('stableKey ignores key order and undefined fields', () => {
  expect(stableKey({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(stableKey({ b: [1, { c: 2 }], a: 1 }));
  expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
});
