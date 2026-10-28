import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { engineResolve } from './potsEngine';
import { resolvePayee } from './potSend';

/**
 * b-Aware 25 Oct 2026 (mahetagaurang22; dup 28 Oct hilmiadi677 H-4): the scheduler resolved payees to a bare
 * address (payeeAddress), so payDue never saw a key, never pinned one, and a changed payee key was never caught.
 */
describe('subscription scheduler resolves payees with their key', () => {
  test('the scheduler hands payDue the full destination (address + key), not payeeAddress', () => {
    const src = readFileSync(new URL('./potsEngine.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/resolve:\s*engineResolve\b/);
    expect(src).not.toMatch(/\bpayeeAddress\b/);
  });

  test('engineResolve is resolvePayee (which returns { address, pubkey })', async () => {
    // Same failure from both on an unresolvable payee: engineResolve goes through resolvePayee.
    const p = { name: 'x', address: 'not-an-address' };
    const a = await engineResolve(p as never).then(String, (e: Error) => e.message);
    const b = await resolvePayee(p as never).then(String, (e: Error) => e.message);
    expect(a).toBe(b);
  });
});
