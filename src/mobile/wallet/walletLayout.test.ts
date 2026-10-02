import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guards for the blank Wallet tab (build after 9793141): TopNav's identity-row spacer
 * was `w-full`, and the Wallet home renders TopNav inside a flex ROW, so the page shrank to 0 px.
 */
const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('wallet layout', () => {
  test('TopNav renders no in-flow full-width element and no identity row (it sits in flex rows too)', () => {
    const src = read('src/mobile/tabs/TopNav.tsx');
    expect(src).not.toContain('IdentityRow');
    expect(src).not.toContain('bw-idrow');
    expect(read('src/mobile/mobile.css')).not.toContain('bw-idrow');
    // The only full-width thing TopNav renders in place is the fixed tool bar; no in-flow spacers.
    expect(src).not.toMatch(/aria-hidden[^\n]*(height|h-\d)/);
    expect(src).toMatch(/grid grid-cols-5 items-center fixed top-0 w-full/);
  });

  test('every Wallet-page mobile insert is behind an error boundary', () => {
    const cfg = read('vite.config.mobile.ts');
    for (const tag of [
      '<MintButton',
      '<HandleOnboarding />',
      '<WalletKindSwitch />',
      '<MediaSection />',
      '<TicketsSection />',
      '<CreditsRow />',
      '<WalletCard ',
    ]) {
      const inserts = cfg.split(tag).slice(1);
      expect(inserts.length).toBeGreaterThan(0);
      // Each replacement that places the widget must open a SectionBoundary right before it.
      const placed = cfg.match(new RegExp(`<SectionBoundary name="[^"]+">${tag.replace(/[<>/{}]/g, '\\$&')}`, 'g'));
      expect(placed?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
