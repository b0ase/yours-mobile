import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BAPP_BARS, bappBarForPath } from './bappBarModel';

// Owner, 16 Oct 2026 (iPhone): opening bMail made the dock useless (a bApp bar with four greyed slots replaced it)
// and swapped the top bar's bPhone button for a second bMail icon. The dock and bPhone must stay on bApp pages.
const read = (file: string) => readFileSync(join(import.meta.dir, '..', file), 'utf8');

describe('bApp pages keep the wallet dock and bPhone', () => {
  test('every bar app is still matched (its icon shows in the top bar)', () => {
    for (const b of BAPP_BARS) expect(bappBarForPath(b.home)?.id).toBe(b.id);
  });

  test('the shell renders the Dock whatever the path, never the bApp bar in its place', () => {
    const src = read('phone/PhoneShell.tsx');
    expect(src).not.toMatch(/<BappBar\b/);
    expect(src).not.toMatch(/!bapp\s*&&\s*\(\s*<Dock/);
    expect(src).toMatch(/\{visible && \(\s*<Dock/);
  });

  test('the top bar keeps the Calls (bPhone) button unconditionally beside the bApp icon', () => {
    const src = read('tabs/TopNav.tsx');
    expect(src).toMatch(/aria-label="Calls"/);
    expect(src).not.toMatch(/bapp \? \(\s*<BappAppButton/);
    expect(src).toMatch(/\{bapp && <BappAppButton/);
  });
});
