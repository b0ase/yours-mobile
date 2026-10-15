import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { promptsShowInPanel } from './panelPrompt';

describe('promptsShowInPanel', () => {
  it('extension with an open panel: prompt goes in the panel', () => {
    expect(promptsShowInPanel(1, { sidePanel: {} })).toBe(true);
  });
  it('phone / web wallet (no sidePanel): never the panel, even with the main window port open', () => {
    // The bChatX-in-frame hang (14 Oct 2026): the web shell connects 'extension-popup' but has no PanelPrompt.
    expect(promptsShowInPanel(1, {})).toBe(false);
    expect(promptsShowInPanel(1, undefined)).toBe(false);
  });
  it('no panel open: falls back to the window / overlay', () => {
    expect(promptsShowInPanel(0, { sidePanel: {} })).toBe(false);
  });
  it('background uses it for the panel decision', () => {
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toMatch(/if \(promptsShowInPanel\(activePopupPorts\.size, chrome\) && kind !== 'unlock'\)/);
  });
});
