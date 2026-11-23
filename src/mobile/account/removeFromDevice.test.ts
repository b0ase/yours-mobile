import { describe, expect, test } from 'bun:test';
import { removeFromDevice } from './deleteAccount';

/** Delete account › "Remove the wallet from this phone" did nothing (5.2.61 build 155): it must reload or throw. */
describe('removeFromDevice', () => {
  const base = () => {
    const log: string[] = [];
    return {
      log,
      d: {
        current: '1me',
        select: async (a: string) => void log.push(`select:${a}`),
        forget: async (a: string) => void log.push(`forget:${a}`),
        dropCaches: (a: string) => void log.push(`drop:${a}`),
        wipeWallet: async () => void log.push('wipe'),
        reload: () => void log.push('reload'),
      },
    };
  };

  test('only account: wipes the wallet, then reloads', async () => {
    const { log, d } = base();
    await removeFromDevice(d);
    expect(log).toEqual(['wipe', 'reload']);
  });

  test('other accounts: switches, forgets this one, then reloads', async () => {
    const { log, d } = base();
    await removeFromDevice({ ...d, next: '1other' });
    expect(log).toEqual(['select:1other', 'forget:1me', 'drop:1me', 'reload']);
  });

  test('a failed wipe is thrown (the screen shows it with Try again), and nothing reloads', async () => {
    const { log, d } = base();
    const err = await removeFromDevice({
      ...d,
      wipeWallet: async () => {
        throw new Error('Could not remove the wallet keys from this phone.');
      },
    }).catch((e: Error) => e);
    expect(String(err)).toContain('Could not remove the wallet keys');
    expect(log).not.toContain('reload');
  });

  test('a step that hangs is cut off with an error, never left spinning', async () => {
    const { log, d } = base();
    const never = () => new Promise<void>(() => undefined);
    const t0 = Date.now();
    const e1 = await removeFromDevice({ ...d, wipeWallet: never, wipeCapMs: 40 }).catch((e: Error) => e);
    expect(String(e1)).toMatch(/Removing the wallet took too long/);
    const e2 = await removeFromDevice({ ...d, next: '1other', forget: never, capMs: 40 }).catch((e: Error) => e);
    expect(String(e2)).toMatch(/Removing this account took too long/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log).not.toContain('reload');
  });
});
