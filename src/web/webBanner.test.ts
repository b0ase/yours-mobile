import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The web build's beta banner pushes the portalled tool bar down. The rule must target a class the tool bar
// really has: a Tailwind-class selector (.grid.grid-cols-5…) silently stopped matching when the bar's grid
// changed, and the banner covered the nav on every page (18 Oct 2026).
const css = readFileSync(new URL('./web.css', import.meta.url), 'utf8');
const nav = readFileSync(new URL('../mobile/tabs/TopNav.tsx', import.meta.url), 'utf8');

test('the tool bar sits under the web banner (stable class on every TopNav variant)', () => {
  expect(css).toMatch(
    /html body > \.bw-topnav \{\s*[^}]*top: calc\(var\(--web-banner-height\) \+ var\(--wallet-inset-top\)\) !important/,
  );
  const bars = nav.match(/className="[^"]*fixed top-0 w-full z-10[^"]*"/g) ?? [];
  expect(bars.length).toBeGreaterThan(0);
  for (const b of bars) expect(b).toContain('bw-topnav');
});
