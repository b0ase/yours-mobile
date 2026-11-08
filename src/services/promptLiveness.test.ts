/**
 * BRC-219 (Wallet Permission Prompt Liveness): no clock on a prompt that is up; a pending request fails only when its
 * prompt was never shown, its surface is gone, or its caller is gone.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  PROMPT_CALLER_GONE_CODE,
  SiteCallTabs,
  promptCallerGoneError,
  siteStillAsking,
  unlockSurfaceGone,
} from './promptLiveness';
import { withPromptNotShownCode } from './promptWatchdog';

const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');

describe('SiteCallTabs: the page that asked is gone', () => {
  test('a closed tab with a waiting call reports its site', () => {
    const t = new SiteCallTabs();
    t.begin(7, 'tokenblaster.lol');
    expect(t.tabGone(7)).toEqual(['tokenblaster.lol']);
    expect(t.waiting(7)).toBe(0);
  });

  test('answered calls are not counted: a closed tab with nothing waiting reports nothing', () => {
    const t = new SiteCallTabs();
    const end = t.begin(7, 'tokenblaster.lol');
    end();
    end(); // idempotent
    expect(t.tabGone(7)).toEqual([]);
  });

  test('another tab of the same site still waiting: its sheets stay (the sheet cannot say which tab asked)', () => {
    const t = new SiteCallTabs();
    t.begin(7, 'tokenblaster.lol');
    const other = t.begin(8, 'tokenblaster.lol');
    expect(t.tabGone(7)).toEqual([]);
    other();
    t.begin(9, 'tokenblaster.lol');
    expect(t.tabGone(9)).toEqual(['tokenblaster.lol']);
  });

  test('only the sites of the closed tab; an end() after the tab went away is harmless', () => {
    const t = new SiteCallTabs();
    const late = t.begin(7, 'a.example');
    t.begin(7, 'b.example');
    t.begin(8, 'c.example');
    expect(t.tabGone(7).sort()).toEqual(['a.example', 'b.example']);
    late();
    expect(t.waiting(8)).toBe(1);
  });

  test('the caller-gone error carries its code to the site', () => {
    const e = promptCallerGoneError();
    expect(e.code).toBe(PROMPT_CALLER_GONE_CODE);
    expect(withPromptNotShownCode({ success: false, error: e.message })).toMatchObject({
      code: PROMPT_CALLER_GONE_CODE,
      status: 410,
    });
  });
});

describe('unlockSurfaceGone: no clock on the unlock screen, only its loss', () => {
  const up = { waiting: 1, setup: false, unlocking: false, panels: 0, popupWindow: false, inPageSheet: false };
  test('nothing can show it any more -> gone', () => {
    expect(unlockSurfaceGone(up)).toBe(true);
  });
  test('a panel, the prompt window or the in-page sheet still up -> keep waiting', () => {
    expect(unlockSurfaceGone({ ...up, panels: 1 })).toBe(false);
    expect(unlockSurfaceGone({ ...up, popupWindow: true })).toBe(false);
    expect(unlockSurfaceGone({ ...up, inPageSheet: true })).toBe(false);
  });
  test('nobody waiting, setup (its own wait) or an unlock already finishing -> not failed here', () => {
    expect(unlockSurfaceGone({ ...up, waiting: 0 })).toBe(false);
    expect(unlockSurfaceGone({ ...up, setup: true })).toBe(false);
    expect(unlockSurfaceGone({ ...up, unlocking: true })).toBe(false);
  });
});

describe('siteStillAsking: the bridge ceiling never closes a sheet the person can still answer', () => {
  test('any shown sheet, other sheet or unlock/setup waiter -> still asking', () => {
    const none = { shownSheets: 0, otherSheets: 0, walletWaiters: 0 };
    expect(siteStillAsking(none)).toBe(false);
    expect(siteStillAsking({ ...none, shownSheets: 1 })).toBe(true);
    expect(siteStillAsking({ ...none, otherSheets: 1 })).toBe(true);
    expect(siteStillAsking({ ...none, walletWaiters: 1 })).toBe(true);
  });
});

describe('background wiring (BRC-219)', () => {
  test('site calls from a tab are counted until answered; a closed or reloaded tab closes its site sheets', () => {
    expect(bg).toContain('? siteCallTabs.begin(sender.tab.id, normalizeOriginator(message.originator))');
    expect(bg).toMatch(/const sendResponse: CallbackResponse = \(response\) => \{\s*endTabCall\(\);/);
    expect(bg).toContain('chrome.tabs?.onRemoved?.addListener((tabId) => onSiteTabGone(tabId));');
    expect(bg).toContain("if (info.status === 'loading') onSiteTabGone(tabId);");
    expect(bg).toContain('closePrompts(prompts, promptCallerGoneError());');
  });

  test('the unlock waiters fail when its panel closes with nothing else showing it, or its window cannot open', () => {
    expect(bg).toMatch(/port\.onDisconnect\.addListener\(\(\) => \{[\s\S]*?failUnlockWaitersIfSurfaceGone\(\);/);
    expect(bg).toContain("} else if (kind === 'unlock') {");
    expect(bg).toContain('failUnlockWaitersIfSurfaceGone(unlockNotShownError());');
    expect(bg).toContain(
      'unlockShown: () => activePopupPorts.size > 0 || popupWindowId !== undefined || inPageSheet !== undefined,',
    );
  });

  test('the bridge ceiling asks first: a sheet the watchdog confirmed on screen keeps the call waiting', () => {
    expect(bg).toContain('shownSheets: prompts.filter((p) => !promptWatchdog.watching(p)).length,');
    expect(bg).toContain('walletWaiters: pendingWalletWaiters.length,');
  });
});
