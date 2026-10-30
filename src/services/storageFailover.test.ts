import { describe, expect, it } from 'bun:test';
import {
  createWithStorageFailover,
  failoverEligible,
  isRemoteStorageFailure,
  REMOTE_FAILING_MESSAGE,
  StorageFailoverError,
} from './storageFailover';

const internal = () => Object.assign(new Error('An internal error has occurred.'), { name: 'WERR_INTERNAL' });

const setup = (plan: (store: 'remote' | 'local', n: number) => unknown, opts: { canSwitch?: boolean } = {}) => {
  let active: 'remote' | 'local' = 'remote';
  const calls: string[] = [];
  let switches = 0;
  return {
    calls,
    switches: () => switches,
    deps: {
      create: async () => {
        calls.push(active);
        const r = plan(active, calls.length);
        if (r instanceof Error) throw r;
        return r as string;
      },
      remoteActive: () => active === 'remote',
      eligible: true,
      switchToLocal: async () => {
        switches++;
        if (opts.canSwitch === false) throw new Error('no local store');
        active = 'local';
      },
    },
  };
};

describe('storageFailover', () => {
  it('remote throws WERR_INTERNAL twice → switches to This device and the local retry succeeds', async () => {
    const s = setup((store) => (store === 'remote' ? internal() : 'txid-local'));
    const out = await createWithStorageFailover(s.deps);
    expect(out).toEqual({ result: 'txid-local', via: 'local' });
    expect(s.calls).toEqual(['remote', 'remote', 'local']);
    expect(s.switches()).toBe(1);
  });

  it('a passing remote hiccup is retried once on the remote, no switch', async () => {
    const s = setup((_store, n) => (n === 1 ? internal() : 'txid'));
    const out = await createWithStorageFailover(s.deps);
    expect(out.via).toBe('remote-retry');
    expect(s.switches()).toBe(0);
  });

  it('no usable local store → clear message pointing to Settings › Storage', async () => {
    const s = setup(() => internal(), { canSwitch: false });
    const err = await createWithStorageFailover(s.deps).catch((e) => e);
    expect(err).toBeInstanceOf(StorageFailoverError);
    expect(err.message).toBe(REMOTE_FAILING_MESSAGE);
    expect(err.code).toBe('WERR_STORAGE_REMOTE_FAILING');
    expect(s.calls).toEqual(['remote', 'remote']);
  });

  it('insufficient funds is not retried', async () => {
    const e = Object.assign(new Error('Insufficient funds'), { name: 'WERR_INSUFFICIENT_FUNDS' });
    const s = setup(() => e);
    expect(await createWithStorageFailover(s.deps).catch((x) => x)).toBe(e);
    expect(s.calls).toEqual(['remote']);
  });

  it('local active: nothing retried', async () => {
    const s = setup(() => internal());
    const err = await createWithStorageFailover({ ...s.deps, remoteActive: () => false }).catch((x) => x);
    expect(err.name).toBe('WERR_INTERNAL');
    expect(s.calls.length).toBe(1);
  });

  it('ineligible calls (sendWith, chains) are not retried', async () => {
    const s = setup(() => internal());
    await createWithStorageFailover({ ...s.deps, eligible: false }).catch(() => undefined);
    expect(s.calls.length).toBe(1);
    expect(failoverEligible({ continuing: false, args: { options: { sendWith: ['a'] } } })).toBe(false);
    expect(failoverEligible({ continuing: true, args: {} })).toBe(false);
    expect(failoverEligible({ continuing: false, args: {} })).toBe(true);
  });

  it('classifies errors', () => {
    expect(isRemoteStorageFailure(internal())).toBe(true);
    expect(isRemoteStorageFailure(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isRemoteStorageFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRemoteStorageFailure(new Error('WERR_INSUFFICIENT_FUNDS: need 10 more'))).toBe(false);
    expect(isRemoteStorageFailure(new Error('User denied'))).toBe(false);
  });
});

describe('storage failover message in the send notice', () => {
  it('classifies the failover error as storage-remote-failing, money not moved', async () => {
    const { classifySendError } = await import('../utils/sendErrors');
    const info = classifySendError(new StorageFailoverError(REMOTE_FAILING_MESSAGE));
    expect(info.kind).toBe('storage-remote-failing');
    expect(info.moneyMoved).toBe('no');
    expect(info.message).toContain('Settings › Storage');
  });
});
