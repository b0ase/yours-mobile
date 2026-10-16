import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// BottomMenuProvider renders the tab bar (mobile/tabs/BottomMenu.tsx) ABOVE <Router>. A react-router hook anywhere
// in that render throws an invariant and blanked the whole wallet right after unlock (owner, 16 Oct 2026).
const OUTSIDE_ROUTER = ['mobile/tabs/BottomMenu.tsx', 'mobile/tabs/useTabBadges.ts'];
const ROUTER_HOOK = /\buse(Location|Navigate|SearchParams|Params|Href|Match|NavigationType|BottomMenu)\(/;

describe('tab bar renders outside the router', () => {
  for (const file of OUTSIDE_ROUTER) {
    test(`${file} calls no router hooks`, () => {
      const src = readFileSync(join(import.meta.dir, '..', '..', file), 'utf8');
      expect(src.match(ROUTER_HOOK)?.[0] ?? null).toBeNull();
    });
  }
});
