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

  test('the dock b is Home only (no hold); the agent is Ask b in the top bar and a tile in Apps', () => {
    const dock = readFileSync(join(import.meta.dir, 'Dock.tsx'), 'utf8');
    expect(dock).toContain('aria-label="Home"');
    expect(dock).not.toMatch(/onAgent|B_HOLD_MS/);
    const top = readFileSync(join(import.meta.dir, '../tabs/TopNav.tsx'), 'utf8');
    expect(top).toContain('Ask b');
    expect(top).toContain("aria-label=\"Calls\"");
    expect(top).toContain("aria-label=\"Media\"");
    const apps = readFileSync(join(import.meta.dir, '../BrowserPage.tsx'), 'utf8');
    expect(apps).toContain('[AGENT_TILE, ...notHome(BAPP_TILES)]');
  });

  test('the phone layout is off by default', () => {
    const src = readFileSync(join(import.meta.dir, 'flag.ts'), 'utf8');
    expect(src).toContain("=== '1'");
  });
});
