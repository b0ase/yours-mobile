import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { enterWallet, type EnterWalletDeps } from './enterWallet';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const run = (over: Partial<EnterWalletDeps>) => {
  const calls: string[] = [];
  const how = enterWallet({
    firstWallet: true,
    sessionSurvivesReload: false,
    remount: () => void calls.push('remount'),
    openAccount: async () => void calls.push('open'),
    reload: () => void calls.push('reload'),
    ...over,
  });
  return { how, calls };
};

/**
 * Mobile smoke test, 16 Nov 2026: Create wallet → Enter showed "Welcome back / Enter your password to unlock". Web and
 * Desktop hold the unlock key in memory only (hub.ts persistSession false), and Enter reloaded the page.
 */
describe('Enter at the end of Create / Restore / Import wallet', () => {
  test('web + Desktop (memory-only session): no reload; the background opens the account, then the screens remount', () => {
    expect(run({})).toEqual({ how: 'remounted', calls: ['open', 'remount'] });
  });

  test('phones and the extension (the session outlives a reload): reload as before', () => {
    expect(run({ sessionSurvivesReload: true })).toEqual({ how: 'reloaded', calls: ['reload'] });
  });

  test('an account added to an existing wallet still reloads (the page holds the previous account)', () => {
    expect(run({ firstWallet: false })).toEqual({ how: 'reloaded', calls: ['reload'] });
  });

  test('no remount registered: reload', () => {
    expect(run({ remount: undefined })).toEqual({ how: 'reloaded', calls: ['reload'] });
  });

  test('a background that never answers does not hold Enter; one that cannot be reached falls back to a reload', () => {
    expect(run({ openAccount: () => new Promise(() => undefined) }).how).toBe('remounted');
    const thrown = run({
      openAccount: () => {
        throw new Error('no background');
      },
    });
    expect(thrown).toEqual({ how: 'reloaded', calls: ['reload'] });
  });

  test('a failed open is logged, never thrown', async () => {
    const warn = console.warn;
    const seen: unknown[] = [];
    console.warn = (...a: unknown[]) => void seen.push(a);
    try {
      expect(run({ openAccount: () => Promise.reject(new Error('boom')) }).how).toBe('remounted');
      await new Promise((r) => setTimeout(r, 0));
      expect(seen.length).toBe(1);
    } finally {
      console.warn = warn;
    }
  });

  test('the three finish screens use it, and nothing about the lock changes', () => {
    for (const f of ['./CreateAccount.tsx', './RestoreAccount.tsx', './ImportAccount.tsx']) {
      const src = read(f);
      expect(src).toContain('acceptTerms();\n            enterWalletNow(newWallet);');
      expect(src).not.toContain('acceptTerms();\n            window.location.reload();');
    }
    // The page says whether the session survives a reload with the same test the hub uses to persist it.
    const main = read('../../mobile/main.ts');
    expect(main).toContain('persistSession: Capacitor.isNativePlatform()');
    expect(main).toContain('sessionSurvivesReload: Capacitor.isNativePlatform()');
    // The remount cannot unlock: the lock check still needs the session key, and no key is written for the remount.
    const provider = read('../../contexts/providers/ServiceProvider.tsx');
    expect(provider).toContain('setIsLocked(!(passKey && withinTimeout));');
    const helper = read('./enterWallet.ts') + read('../../appRemount.ts');
    expect(helper).not.toMatch(/sessionStorage|localStorage|setPassKey|storage\.(session|local)\.set/);
    expect(read('../../index.tsx')).toContain('<RootErrorBoundary key={generation}>');
  });
});
