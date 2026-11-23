import { describe, expect, test } from 'bun:test';
import { removeFromDevice } from './deleteAccount';

/**
 * Delete account › "Remove the wallet from this phone" did nothing (5.2.61 build 155): it must reload or throw.
 * Round 2 (key-wipe review of 04f9513b): Try again must never touch the account being kept.
 */
const acct = (id: string) => ({ addresses: { identityAddress: id }, encryptedKeys: `enc-${id}` });

/** A phone's storage: the accounts map and the selection, as a fresh read sees them. */
const phone = (ids: string[], selected: string) => {
  const log: string[] = [];
  const s = {
    accounts: Object.fromEntries(ids.map((id) => [id, acct(id)])) as Record<string, unknown>,
    selected,
  };
  const d = {
    readAccounts: async () => ({ ...s.accounts }),
    closeWallet: async () => void log.push('close'),
    select: async (a: string) => {
      log.push(`select:${a}`);
      s.selected = a;
    },
    forget: async (a: string) => {
      log.push(`forget:${a}`);
      delete s.accounts[a];
    },
    dropCaches: (a: string) => void log.push(`drop:${a}`),
    wipeWallet: async () => void log.push('wipe'),
    reload: () => void log.push('reload'),
  };
  return { log, s, d };
};

describe('removeFromDevice', () => {
  test('only account: wipes the wallet, then reloads', async () => {
    const { log, d } = phone(['A'], 'A');
    await removeFromDevice({ ...d, target: { deleted: 'A' } });
    expect(log).toEqual(['wipe', 'reload']);
  });

  test('other accounts: switches, closes the wallet, forgets this one, then reloads', async () => {
    const { log, d, s } = phone(['A', 'B'], 'A');
    await removeFromDevice({ ...d, target: { deleted: 'A', next: 'B' } });
    expect(log).toEqual(['select:B', 'close', 'forget:A', 'drop:A', 'reload']);
    expect(Object.keys(s.accounts)).toEqual(['B']);
  });

  test('H1: Try again after a failed forget removes the pinned account, never the one kept', async () => {
    const { log, d, s } = phone(['A', 'B'], 'A');
    let fail = true;
    const forget = async (a: string) => {
      if (fail) throw new Error('Wallet keys are being re-encrypted; try again in a moment');
      await d.forget(a);
    };
    const target = { deleted: 'A', next: 'B' };
    await expect(removeFromDevice({ ...d, forget, target })).rejects.toThrow(/re-encrypted/);
    expect(s.selected).toBe('B'); // the selection moved: the page cache now says "current = B"
    fail = false;
    await removeFromDevice({ ...d, forget, target });
    expect(Object.keys(s.accounts)).toEqual(['B']);
    expect(log).not.toContain('select:A');
    expect(log).not.toContain('forget:B');
    expect(log).not.toContain('wipe');
  });

  test('H1: a forget that landed but timed out is skipped on Try again, and never becomes a whole-wallet wipe', async () => {
    const { log, d, s } = phone(['A', 'B'], 'A');
    let first = true;
    const forget = async (a: string) => {
      await d.forget(a);
      if (first) {
        first = false;
        await new Promise<void>(() => undefined); // landed, then hung
      }
    };
    const target = { deleted: 'A', next: 'B' };
    await expect(removeFromDevice({ ...d, forget, target, capMs: 30 })).rejects.toThrow(/took too long/);
    log.length = 0;
    await removeFromDevice({ ...d, forget, target, capMs: 30 });
    expect(log).toEqual(['select:B', 'drop:A', 'reload']);
    expect(Object.keys(s.accounts)).toEqual(['B']);
  });

  test('the whole wallet is wiped only when a fresh read shows no other real account', async () => {
    // Pinned with no next (the page cache missed B), but storage has B: switch to it, don't wipe.
    const { log, d } = phone(['A', 'B'], 'A');
    await removeFromDevice({ ...d, target: { deleted: 'A' } });
    expect(log).not.toContain('wipe');
    expect(log).toContain('forget:A');
    // A leftover entry that is no real account (no addresses) doesn't count.
    const p = phone(['A'], 'A');
    p.s.accounts.junk = { settings: {} };
    await removeFromDevice({ ...p.d, target: { deleted: 'A' } });
    expect(p.log).toEqual(['wipe', 'reload']);
  });

  test('L6: no pinned account and other accounts present: refuses, wipes nothing', async () => {
    const { log, d } = phone(['A', 'B'], 'A');
    await expect(removeFromDevice({ ...d, target: { deleted: undefined } })).rejects.toThrow();
    expect(log).toEqual([]);
  });

  test("M1: the deleted account written back after forget fails the step (it's checked with a fresh read)", async () => {
    const { log, d, s } = phone(['A', 'B'], 'A');
    const forget = async (a: string) => {
      await d.forget(a);
      s.accounts.A = acct('A'); // a background updateNested writes A back
    };
    await expect(removeFromDevice({ ...d, forget, target: { deleted: 'A', next: 'B' } })).rejects.toThrow(
      /still on this phone/,
    );
    expect(log).not.toContain('reload');
    expect(log.indexOf('close')).toBeLessThan(log.indexOf('forget:A'));
  });

  test('a failed wipe is thrown (the screen shows it with Try again), and nothing reloads', async () => {
    const { log, d } = phone(['A'], 'A');
    const wipeWallet = async () => {
      throw new Error('Could not remove the wallet keys from this phone.');
    };
    await expect(removeFromDevice({ ...d, wipeWallet, target: { deleted: 'A' } })).rejects.toThrow(/wallet keys/);
    expect(log).not.toContain('reload');
  });

  test('M2: a slow wipe is never abandoned by an outer cap (its own steps are capped)', async () => {
    const { log, d } = phone(['A'], 'A');
    const wipeWallet = () => new Promise<void>((r) => setTimeout(() => (log.push('wipe'), r()), 120));
    await removeFromDevice({ ...d, wipeWallet, target: { deleted: 'A' }, capMs: 20 });
    expect(log).toEqual(['wipe', 'reload']);
  });

  test('a switch or forget that hangs is cut off with an error, never left spinning', async () => {
    const never = () => new Promise<void>(() => undefined);
    const { log, d } = phone(['A', 'B'], 'A');
    const t0 = Date.now();
    await expect(
      removeFromDevice({ ...d, select: never, target: { deleted: 'A', next: 'B' }, capMs: 30 }),
    ).rejects.toThrow(/Switching to your other account took too long/);
    await expect(
      removeFromDevice({ ...d, forget: never, target: { deleted: 'A', next: 'B' }, capMs: 30 }),
    ).rejects.toThrow(/Removing this account took too long/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log).not.toContain('reload');
  });
});
