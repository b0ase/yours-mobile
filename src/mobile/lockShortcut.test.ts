import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isLockShortcut, lockShortcutLabel } from './lockShortcut';

const k = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('lock shortcut', () => {
  test('⌘L and Ctrl+L lock; plain L, ⌥⌘L and ⇧⌘L do not', () => {
    expect(isLockShortcut(k('l', { metaKey: true }))).toBe(true);
    expect(isLockShortcut(k('L', { ctrlKey: true }))).toBe(true);
    expect(isLockShortcut(k('l'))).toBe(false);
    expect(isLockShortcut(k('l', { metaKey: true, altKey: true }))).toBe(false);
    expect(isLockShortcut(k('l', { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isLockShortcut(k('k', { metaKey: true }))).toBe(false);
  });
  test('label follows the platform', () => {
    expect(lockShortcutLabel('MacIntel')).toBe('⌘L');
    expect(lockShortcutLabel('Win32')).toBe('Ctrl+L');
  });
  test('the plain web account menu has a labelled lock button and the shortcut', () => {
    const nav = readFileSync(new URL('./tabs/TopNav.tsx', import.meta.url), 'utf8');
    expect(nav).toContain('useLockShortcut(');
    expect(nav).toContain('aria-label="Lock wallet"');
    expect(nav).toMatch(/>\s*Lock\s*</);
  });
});
