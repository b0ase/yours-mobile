import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEVICE_DATA_NOTE,
  LocalStoreNeededError,
  ensureLocalStore,
  isOnDeviceStore,
  requireLocalStoreForChange,
  type EnsureLocalDeps,
  type StoreConfigLike,
} from './localFirst';
import type { SwitchResult } from './restoreFromRemote';

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
      if (over.switchOk === false)
        return { ok: false, reason: 'device still holds less than the backup', activeIsRemote: true };
      state.local = true;
      return { ok: true, remote: S, local: S };
    },
    localIsEmpty: async () => false,
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
    expect(b.state.switches).toBe(1);
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
    expect(readFileSync('src/pages/Settings.tsx', 'utf8')).toContain('onDeviceStore={isOnDeviceStore(');
    expect(readFileSync('src/pages/onboarding/RestoreAccount.tsx', 'utf8')).toContain(
      '<DeviceDataNote onDevice={false} />',
    );
  });
});
