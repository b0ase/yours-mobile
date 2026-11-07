/**
 * Review 24, S1: native Review & sign / Sign & seal and the background's one-Seal-sheet pass are bWalletX only, absent
 * from a store build even as code (storeBuild.ts NATIVE_SEAL_ENABLED). The store grep after `build:mobile:store` is the
 * proof; these source checks keep the gate from being undone by a static import between releases.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const LITERAL = /!\(\s*import\.meta\.env\.VITE_STORE_BUILD === '1' \|\|/;

describe('native seal: not in a store build', () => {
  test('MobileRoutes loads NativeSealPage lazily, only behind NATIVE_SEAL_ENABLED', () => {
    const routes = src('mobile/tabs/MobileRoutes.tsx');
    expect(routes).not.toMatch(/^import .*NativeSealPage/m);
    expect(routes).toMatch(/const NativeSealPage = NATIVE_SEAL_ENABLED\s*\?\s*lazy\(/);
    expect(routes).toMatch(/\{NativeSealPage && <Route path="seal\/:ticker\/:doc"/);
  });

  test('NATIVE_SEAL_ENABLED is the literal store check', () => {
    const flags = src('mobile/storeBuild.ts');
    const i = flags.indexOf('export const NATIVE_SEAL_ENABLED');
    expect(i).toBeGreaterThan(-1);
    expect(flags.slice(i, i + 300)).toMatch(LITERAL);
  });

  test('sign links and document buttons only route to the native screen when it exists', () => {
    expect(src('mobile/chat/useSignLinks.ts')).toMatch(/if \(NATIVE_SEAL_ENABLED && s\.docId\)/);
    expect(src('mobile/chat/nativeSeal.ts')).toMatch(/if \(!NATIVE_SEAL_ENABLED\) return null;/);
  });

  test('the background seal pass and the oneApprovalSeal capability are off in a store build', () => {
    const bg = src('background.ts');
    const at = (needle: string) => {
      const i = bg.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return bg.slice(Math.max(0, i - 400), i + needle.length);
    };
    expect(at('? new SealPasses()')).toMatch(LITERAL);
    expect(at('askSealSheet(message.originator, sealSheetFor(')).toMatch(LITERAL);
    expect(at('? readSealSign(')).toMatch(LITERAL);
    expect(at('sealPasses.coversProtocol(')).toMatch(LITERAL);
    expect(src('mobile/bappFrame/frameBridge.ts')).toMatch(/\[ONE_APPROVAL_SEAL\]: NATIVE_SEAL_ENABLED/);
    expect(src('mobile/pair/bitsign.ts')).toMatch(/\[ONE_APPROVAL_SEAL\]: NATIVE_SEAL_ENABLED/);
  });
});
