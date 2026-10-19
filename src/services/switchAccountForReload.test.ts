import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ChromeStorageService } from './ChromeStorage.service';

const make = () => {
  const calls: string[] = [];
  const svc = new ChromeStorageService();
  svc.update = mock(async (o: Record<string, unknown>) => void calls.push(`update:${o.selectedAccount}`)) as never;
  svc.switchAccount = mock(async (id: string) => void calls.push(`switch:${id}`)) as never;
  return { svc, calls };
};

describe('switchAccountForReload (one wallet init per account switch)', () => {
  test('in-page background (web, apps): only the selection is saved; the reload opens the account once', async () => {
    const { svc, calls } = make();
    await svc.switchAccountForReload('1abc', false);
    expect(calls).toEqual(['update:1abc']);
  });
  test('extension (service worker outlives the page): switched as before', async () => {
    const { svc, calls } = make();
    await svc.switchAccountForReload('1abc', true);
    expect(calls).toEqual(['switch:1abc']);
  });
  test('Create wallet "Next" and the account switchers use it before their reload', () => {
    for (const f of [
      '../pages/onboarding/CreateAccount.tsx',
      '../mobile/account/accountSwitch.ts',
      '../components/TopNav.tsx',
    ])
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain('switchAccountForReload(identityAddress)');
    // The phone/web build rewrites Create's "Next" (vite.config.mobile.ts); it must keep the same call.
    const mobile = readFileSync(new URL('../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(mobile).toContain('chromeStorageService.switchAccountForReload(identityAddress).catch(');
  });
});
