import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { walletReady } from './walletReady';

const storage = (account: unknown) => ({ getCurrentAccountObject: () => ({ account }) as never });

describe('walletReady', () => {
  test('false before a wallet exists (welcome / create screens), even though the app reports unlocked', () => {
    expect(walletReady(storage(undefined), false)).toBe(false);
    expect(walletReady(storage({ addresses: {} }), false)).toBe(false);
    expect(walletReady(undefined, false)).toBe(false);
  });
  test('false while locked, true for an existing unlocked wallet', () => {
    expect(walletReady(storage({ encryptedKeys: 'x' }), true)).toBe(false);
    expect(walletReady(storage({ encryptedKeys: 'x' }), false)).toBe(true);
  });
  test('the app-wide profile and bMail badge lookups wait for it (no "Wallet not available" on first load)', () => {
    const id = readFileSync(new URL('../hooks/useIdentity.ts', import.meta.url), 'utf8');
    expect(id).toContain('const ready = walletReady(chromeStorageService, isLocked);');
    expect(id).toMatch(/const loadIdentity = useCallback\(async \(\) => \{\n\s+if \(!ready\) \{/);
    const mail = readFileSync(new URL('../mobile/bmail/useBMail.ts', import.meta.url), 'utf8');
    expect(mail).toContain('if (wallet && ready)');
    expect(mail).toContain('}, [wallet, ready]);');
  });
});
