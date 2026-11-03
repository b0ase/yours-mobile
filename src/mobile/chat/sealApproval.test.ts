import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { approveSealPayment } from './sealApproval';

const run = (status: 'ok' | 'cancelled' | 'unavailable', password: boolean) => {
  const asked: string[] = [];
  const p = approveSealPayment('Seal this document and pay about 75 sats', 'bChatX', {
    auth: async () => (status === 'ok' ? { status, method: 'biometric' as const } : { status }),
    passwordAuth: async (reason) => (asked.push(reason), password),
  });
  return p.then((ok) => ({ ok, asked }));
};

describe('seal payment approval: never a silent pass', () => {
  test('Face ID / passcode ok approves', async () => {
    expect(await run('ok', false)).toEqual({ ok: true, asked: [] });
  });
  test('cancelled refuses and never asks for the password', async () => {
    expect(await run('cancelled', true)).toEqual({ ok: false, asked: [] });
  });
  test('biometrics unavailable: refused unless the password sheet is completed', async () => {
    expect((await run('unavailable', false)).ok).toBe(false);
    const done = await run('unavailable', true);
    expect(done.ok).toBe(true);
    expect(done.asked).toEqual(['Seal this document and pay about 75 sats']);
  });
  test('the seal page uses it, and nothing treats unavailable as approval', () => {
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('approveSealPayment(');
    expect(page).toContain('passwordAuth: askWalletPassword');
    expect(page).not.toMatch(/status === 'unavailable'\s*;?\s*$/m);
    expect(page).not.toMatch(/=== 'ok' \|\| \w+\.status === 'unavailable'/);
  });
});
