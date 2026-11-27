import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';

// RB, 27 Nov 2026 on scammerscartel.com: signing out of a site turned the extension panel TO the website's theme.
// The content script kept watching the page after the sign-out, so the meta change that comes with it re-announced
// the page and the panel wore its look again; the bundled pack was also never dropped on disconnect.
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

describe('a site that signs out loses its look in the panel', () => {
  it('content.ts stops re-announcing the page theme on disconnect', () => {
    const fn = between(src('../../content.ts'), 'function sendDisconnect()', "chrome.runtime.sendMessage({ action: 'bwxSiteDisconnect' })");
    expect(fn).toContain('themeWatch?.disconnect()');
    expect(fn).toContain('themeWatch = undefined');
    expect(fn).toContain('clearInterval(themeTimer)');
    expect(fn).toContain('sentTheme = undefined');
  });

  it('the 1 s re-check is a timer that a disconnect can stop', () => {
    expect(src('../../content.ts')).toContain('themeTimer = setInterval(sendSiteTheme, 1000)');
  });

  it('background drops the pack, the path and the origin for that tab', () => {
    const bg = src('../../background.ts');
    const block = between(bg, "message?.action === 'bwxSiteDisconnect'", 'return false;');
    expect(block).toContain('siteThemeTabs.delete(t)');
    expect(block).toContain('sitePathTabs.delete(t)');
    expect(block).toContain('siteOriginTabs.delete(t)');
    expect(block).toContain('pushSiteTheme()');
  });
});
