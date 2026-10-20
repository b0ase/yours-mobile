import { readFileSync } from 'fs';
import { join } from 'path';
import { migrationRowText } from './migrationRow';

describe('migration row', () => {
  it('describes the tool when nothing is known to be left', () => {
    expect(migrationRowText(undefined)).toMatch(/from Yours or old addresses/);
    expect(migrationRowText(0)).toMatch(/from Yours or old addresses/);
  });
  it('counts items left', () => {
    expect(migrationRowText(1)).toBe('1 item still at your old address. Bring them in');
    expect(migrationRowText(62)).toMatch(/^62 items/);
  });
  it('is mounted exactly once, unconditionally, on the wallet home', () => {
    const src = readFileSync(join(__dirname, '../pages/BsvWallet.tsx'), 'utf8');
    expect(src.match(/data-testid="migration-tool-row"/g)?.length).toBe(1);
    expect(src).not.toMatch(/Open migration tool/);
    expect(src).not.toMatch(/showMigrationBanner/);
    expect(src.match(/Bring in old assets\n/g)?.length).toBe(1);
  });
});
