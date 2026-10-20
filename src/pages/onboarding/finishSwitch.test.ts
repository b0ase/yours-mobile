import { describe, expect, test } from 'bun:test';
import { switchBeforeReload } from './finishSwitch';

describe('switchBeforeReload (end of Restore / Import wallet)', () => {
  test('selects the account for a reload and finishes when the background answers', async () => {
    const seen: string[] = [];
    await switchBeforeReload({ switchAccountForReload: async (a) => void seen.push(a) }, '1Identity', 1000);
    expect(seen).toEqual(['1Identity']);
  });

  test('a background that never answers no longer holds the screen: it carries on after the wait', async () => {
    const started = Date.now();
    await switchBeforeReload({ switchAccountForReload: () => new Promise<void>(() => undefined) }, '1Identity', 30);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a real error from the wallet is still thrown', async () => {
    await expect(
      switchBeforeReload(
        {
          switchAccountForReload: async () => {
            throw new Error('Error: wallet could not start');
          },
        },
        '1Identity',
        1000,
      ),
    ).rejects.toThrow('wallet could not start');
  });
});
