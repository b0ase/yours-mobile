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
  test('TopNav renders no full-width in-flow element (it sits in flex rows too)', () => {
    const src = read('src/mobile/tabs/TopNav.tsx');
    const spacer = src.split('\n').find((l) => l.includes('aria-hidden') && l.includes('IDENTITY_ROW_H'));
    expect(spacer).toBeDefined();
    expect(spacer).not.toContain('w-full');
    expect(spacer).toContain('width: 0');
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
    ]) {
      const inserts = cfg.split(tag).slice(1);
      expect(inserts.length).toBeGreaterThan(0);
      // Each replacement that places the widget must open a SectionBoundary right before it.
      const placed = cfg.match(new RegExp(`<SectionBoundary name="[^"]+">${tag.replace(/[<>/{}]/g, '\\$&')}`, 'g'));
      expect(placed?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
