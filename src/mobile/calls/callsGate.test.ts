import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('calls polling', () => {
  test('starts only once a wallet exists and is unlocked (no identity-key polling on the welcome screens)', () => {
    const src = readFileSync(new URL('./CallScreen.tsx', import.meta.url), 'utf8');
    expect(src).toContain('account?.encryptedKeys');
    expect(src).toContain('if (isLocked || !hasWallet || !apiContext?.wallet) return stopCalls();');
  });
});
