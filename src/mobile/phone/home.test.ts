import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { defaultDock, normaliseDock } from './dockModel';

describe('HOME', () => {
  test('HOME is just the app grid: no balance card, no Send / Receive (owner: "it spoils the effect")', () => {
    const src = readFileSync(join(import.meta.dir, 'HomeScreen.tsx'), 'utf8');
    expect(src).not.toContain('header=');
    expect(src).not.toMatch(/SendReceive|Balance/);
  });

  test('the safeguard: Wallet (with Send / Receive) is the leftmost dock item by default, every build', () => {
    for (const store of [false, true]) {
      expect(defaultDock(store)[0]).toEqual({ kind: 'screen', id: 'wallet' });
      expect(normaliseDock(null, store)[0]).toEqual({ kind: 'screen', id: 'wallet' });
    }
  });

  test('dock b: tap = Home, hold = the agent page; top bar is Accounts · Calls · b · Media · Settings', () => {
    const dock = readFileSync(join(import.meta.dir, 'Dock.tsx'), 'utf8');
    expect(dock).toContain('onTouchStart');
    expect(dock).toContain('B_HOLD_MS');
    expect(dock).toContain("WebkitTouchCallout: 'none'");
    expect(dock).toContain('e.preventDefault()');
    const shell = readFileSync(join(import.meta.dir, 'PhoneShell.tsx'), 'utf8');
    expect(shell).toContain("onAgent={() => navigate('/m/agent')}");
    const top = readFileSync(join(import.meta.dir, '../tabs/TopNav.tsx'), 'utf8');
    const row = top.slice(top.indexOf('owner round 3'));
    const order = [
      'aria-label="Accounts menu"',
      'aria-label="Calls"',
      "'b agent'",
      'aria-label="Media"',
      'aria-label="Settings and lock"',
    ].map((l) => row.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(top).toContain('{!phone && <AccountStrip />}');
    const apps = readFileSync(join(import.meta.dir, '../BrowserPage.tsx'), 'utf8');
    expect(apps).toContain('[AGENT_TILE, ...notHome(BAPP_TILES)]');
  });

  test('HOME is a fixed 4 × 6 page with Your apps and Recents below', () => {
    const apps = readFileSync(join(import.meta.dir, '../BrowserPage.tsx'), 'utf8');
    expect(apps).toContain('const HOME_ROWS = 6;');
    expect(apps).toContain('const HOME_SLOTS = 4 * HOME_ROWS;');
    expect(apps).toContain('HOME_SLOTS - first.length');
    expect(apps.indexOf('Your apps')).toBeLessThan(apps.indexOf('>Recents<'));
  });

  test('keep-alive paging: strip pages stay mounted; off-screen pages hide and give up the bApp frame', () => {
    const pager = readFileSync(join(import.meta.dir, 'pager.tsx'), 'utf8');
    expect(pager).toContain('keptPages.add(page.id)');
    expect(pager).toContain('screens.map((_, i) =>');
    expect(pager).not.toMatch(/keptPages\.delete|keptPages\.clear/);
    const apps = readFileSync(join(import.meta.dir, '../BrowserPage.tsx'), 'utf8');
    expect(apps).toContain('if (offScreen) return;');
    const chat = readFileSync(join(import.meta.dir, '../tabs/ChatPage.tsx'), 'utf8');
    expect(chat).toContain("display: offScreen ? 'none' : undefined");
    const dots = readFileSync(join(import.meta.dir, 'PageDots.tsx'), 'utf8');
    expect(dots).toContain('data-testid="page-title"');
  });

  test('the phone layout is off by default', () => {
    const src = readFileSync(join(import.meta.dir, 'flag.ts'), 'utf8');
    expect(src).toContain("=== '1'");
  });
});
