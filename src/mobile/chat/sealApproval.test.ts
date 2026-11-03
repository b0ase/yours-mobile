import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { approveSealPayment, approveSealWithSheet } from './sealApproval';
import { createOneClickGuard } from '../settings/oneClick';

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

describe('the payment sheet, every time: never auto-approved', () => {
  const info = { title: 'Minute 011', ticker: 'BCORP', docHash: 'abcd1234', handle: 'b0asex', feeSats: 75, blocks: 1 };
  const gate = (sheetAnswer: boolean, status: 'ok' | 'cancelled' | 'unavailable', password = false) => {
    const log: string[] = [];
    const p = approveSealWithSheet(info, {
      showSheet: async (s) => (log.push(`sheet:${s.title}:${s.feeSats}`), sheetAnswer),
      confirm: () =>
        approveSealPayment('Seal Minute 011 on Bitcoin and pay about 75 sats', 'bChatX', {
          auth: async () => (
            log.push('faceid'),
            status === 'ok' ? { status, method: 'biometric' as const } : { status }
          ),
          passwordAuth: async () => (log.push('password'), password),
        }),
    });
    return p.then((ok) => ({ ok, log }));
  };

  test('Approve on the sheet, then Face ID: sealed', async () => {
    expect(await gate(true, 'ok')).toEqual({ ok: true, log: ['sheet:Minute 011:75', 'faceid'] });
  });
  test('Cancel on the sheet: refused, and no Face ID or password prompt is even asked', async () => {
    expect(await gate(false, 'ok', true)).toEqual({ ok: false, log: ['sheet:Minute 011:75'] });
  });
  test('Approve on the sheet but Face ID cancelled: refused', async () => {
    expect((await gate(true, 'cancelled', true)).ok).toBe(false);
  });
  test("'unavailable' cannot approve without the wallet password, even after the sheet", async () => {
    expect(await gate(true, 'unavailable', false)).toEqual({
      ok: false,
      log: ['sheet:Minute 011:75', 'faceid', 'password'],
    });
    expect((await gate(true, 'unavailable', true)).ok).toBe(true);
  });
  test('a spending limit set high enough to cover the seal still shows the sheet, every time', async () => {
    // One-click pay on, 10,000 sat limit: elsewhere in the app a 75 sat payment would skip its confirm step.
    const oneClick = createOneClickGuard(() => ({ oneClick: true, oneClickLimit: 10_000 }));
    expect(oneClick.peek(75).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const r = await gate(false, 'ok', true);
      expect(r).toEqual({ ok: false, log: ['sheet:Minute 011:75'] });
    }
    // The gate takes no limit, allowance or remembered grant: only the sheet and the prompt.
    expect(approveSealWithSheet.length).toBe(2);
  });
  test('a non-boolean confirm is not approval', async () => {
    const ok = await approveSealWithSheet(info, {
      showSheet: async () => true,
      confirm: async () => 'yes' as unknown as boolean,
    });
    expect(ok).toBe(false);
  });
  test('no remembered authorisation, allowance or one-click setting anywhere in the seal flow', () => {
    for (const f of [
      './NativeSealPage.tsx',
      './sealApproval.ts',
      './SealPaySheet.tsx',
      './nativeSeal.ts',
      './sealScreen.ts',
    ]) {
      const code = readFileSync(new URL(f, import.meta.url), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
      expect(code).not.toMatch(
        /oneClick|indexAutoPay|spendingAuthori|allowance|permissionStore|sealPass|dontAsk|remember/i,
      );
    }
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    // Every seal goes through the sheet: approve() always calls approveSealWithSheet(…, { showSheet, … }).
    expect(page).toContain('return await approveSealWithSheet(info, {');
    expect(page).toMatch(/approveSealWithSheet\(info, \{\s*showSheet,/);
    // The sheet reused is the wallet's own approval card.
    const sheet = readFileSync(new URL('./SealPaySheet.tsx', import.meta.url), 'utf8');
    expect(sheet).toContain("from '../../components/approval/ApprovalCard'");
    expect(sheet).toContain('<PayHero');
  });
});
