import { describe, expect, it } from 'bun:test';
import { promptCloseTarget } from './promptCloseTarget';

const extOrigin = 'chrome-extension://abc/';
const promptUrl = `${extOrigin}prompt.html`;
const base = { extOrigin, promptUrl };

describe('promptCloseTarget', () => {
  it('closes our own popup window when every tab in it is ours', () => {
    expect(
      promptCloseTarget({
        ...base,
        windowId: 7,
        window: { type: 'popup', tabs: [{ id: 1, url: `${promptUrl}?kind=x` }] },
      }),
    ).toEqual({ type: 'window', windowId: 7 });
  });

  it('never closes a normal window holding the wallet tab and the site tab: only the prompt tab goes', () => {
    const window = {
      type: 'normal',
      tabs: [
        { id: 1, url: 'https://site.example/swap' },
        { id: 2, url: `${promptUrl}?kind=transaction` },
      ],
    };
    expect(
      promptCloseTarget({ ...base, windowId: 9, window, senderTab: { id: 2, url: `${promptUrl}?kind=transaction` } }),
    ).toEqual({ type: 'tab', tabId: 2 });
  });

  it('never closes a popup window that also holds a site tab', () => {
    const window = {
      type: 'popup',
      tabs: [
        { id: 1, url: 'https://site.example' },
        { id: 2, url: promptUrl },
      ],
    };
    expect(promptCloseTarget({ ...base, windowId: 9, window })).toEqual({ type: 'tab', tabId: 2 });
  });

  it('hides an in-page sheet instead of closing the site tab or its window', () => {
    expect(
      promptCloseTarget({
        ...base,
        windowId: 9,
        window: { type: 'normal', tabs: [{ id: 1, url: 'https://site.example' }] },
        senderTab: { id: 1, url: 'https://site.example' },
        senderFrameId: 3,
      }),
    ).toEqual({ type: 'sheet', tabId: 1 });
  });

  it('closes nothing when the sender is a site tab and no prompt tab is found', () => {
    expect(
      promptCloseTarget({
        ...base,
        windowId: 9,
        window: { type: 'normal', tabs: [{ id: 1, url: 'https://site.example' }] },
        senderTab: { id: 1, url: 'https://site.example' },
      }),
    ).toEqual({ type: 'none' });
  });

  it('closes nothing when the window is gone', () => {
    expect(promptCloseTarget({ ...base, windowId: 9 })).toEqual({ type: 'none' });
  });
});
