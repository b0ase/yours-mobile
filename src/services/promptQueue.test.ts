import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { panelUnlockMessages, shouldPushPrompt } from './promptQueue';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('one approval at a time', () => {
  const a = { kind: 'bundle', requestID: 'a' };
  const b = { kind: 'permission', requestID: 'b' };
  test('a second request waits while the first is still on screen and pending', () => {
    expect(shouldPushPrompt(a, true, b)).toBe(false);
  });
  test('it is pushed once the first was answered, or when nothing is showing', () => {
    expect(shouldPushPrompt(a, false, b)).toBe(true);
    expect(shouldPushPrompt(undefined, false, b)).toBe(true);
  });
  test('the same request may refresh in place (a bundle gaining "+1 more")', () => {
    expect(shouldPushPrompt(a, true, { ...a })).toBe(true);
  });
  test('background routes every push through the queue check and remembers what is shown', () => {
    const bg = src('../background.ts');
    expect(bg).toMatch(/shouldPushPrompt\(/);
    expect(bg).toMatch(/shownPrompt = \{ kind, requestID \}/);
  });
  test('prompt pages are keyed by request so a new one never inherits a spinning Allow', () => {
    const tab = src('../prompt-tab.tsx');
    for (const page of [
      'PermissionRequestPage',
      'GroupedPermissionRequestPage',
      'CounterpartyPermissionRequestPage',
      'OneSatPermissionRequestPage',
      'UsbCheckRequestPage',
    ])
      expect(tab).toMatch(new RegExp(`<${page}\\s+key=\\{screen\\.requestID\\}`));
  });
});

describe('locked wallet + open side panel', () => {
  test('clears a stale prompt overlay, then shows the unlock screen', () => {
    expect(panelUnlockMessages().map((m) => m.action)).toEqual(['HIDE_PROMPT_PANEL', 'SHOW_UNLOCK_PANEL']);
    const bg = src('../background.ts');
    expect(bg).not.toMatch(/extension popup is connected, skipping window creation/);
    expect(bg).toMatch(/panelUnlockMessages\(\)\.forEach/);
    expect(src('../App.tsx')).toMatch(/SHOW_UNLOCK_PANEL[\s\S]{0,80}setIsLocked\(true\)/);
    expect(src('../mobile/PanelPrompt.tsx')).toMatch(/SHOW_UNLOCK_PANEL/);
  });
  test('closing with nothing left always hides the panel overlay', () => {
    const bg = src('../background.ts');
    const hide = bg.slice(bg.indexOf('const hidePanelPrompt'), bg.indexOf('const hidePanelPrompt') + 300);
    expect(hide).not.toMatch(/if \(!promptInPanel\) return/);
  });
});
