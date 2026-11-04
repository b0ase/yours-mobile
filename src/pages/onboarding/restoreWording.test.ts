/**
 * Release click-through, 4 Nov 2026: the in-app restore screen said the 12 words "are all you need". Change from
 * payments made before this update can be recorded only on the device that made it, so it now gives the same advice
 * as bwalletx.com's restore copy (bwalletx-site 49f9c9a): keep the old device until this one shows the right balance.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

test('the restore screen never says the 12 words are all you need, and says to keep the old device', () => {
  const src = readFileSync(join(import.meta.dir, 'RestoreAccount.tsx'), 'utf8');
  expect(src).not.toMatch(/all you need/i);
  expect(src).toContain(
    'If your old device still works, keep bWalletX on it until this one shows the right balance: some change from before this update is recorded only on the device that made it.',
  );
});
