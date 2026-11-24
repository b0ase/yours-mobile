import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * No test may call bun's module mock. It is process-wide and outlives its file: when CI runs the suite in one process
 * (Linux file order), the fake leaks into whichever file runs next. It caused the #558 CI failure (swapSetAside mocked
 * killSwitch, then bizAgent saw a no-op assertNotPaused). Inject the dependency instead: a stub through the function's
 * own parameter or options (the real one is the default), or stub globalThis.fetch per test and restore it in
 * afterEach. Safety modules (killSwitch, tokenSpendGuard, spending guards, envelopes, biometric gates) are never
 * module-mocked, allowlist or not.
 *
 * The allowlist is explicit and each entry says why. A path ending in "/" allows the whole folder. Do not add to it
 * to make this test pass: fix the test.
 */
const ALLOWED: { path: string; why: string }[] = [
  { path: 'src/mobile/chat/', why: 'open PR #560 owns these tests; sweep them when it merges' },
  { path: 'src/mobile/signed/', why: 'open PR #561 owns these tests; sweep them when it merges' },
];

// Built from parts so this file's own text never matches itself.
const CALL = new RegExp(['mock', '\\.', 'module', '\\s*\\('].join(''));
const TEST_FILE = /\.test\.tsx?$/;

const root = join(import.meta.dir, '..', '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEST_FILE.test(name)) out.push(full);
  }
  return out;
};

describe('no bun module mocks in tests', () => {
  test('only the allowlisted folders call it', () => {
    const offenders = walk(join(root, 'src'))
      .map((f) => relative(root, f).split(sep).join('/'))
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a.path)))
      .filter((f) => CALL.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('every allowlist entry says why', () => {
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(10);
  });
});
