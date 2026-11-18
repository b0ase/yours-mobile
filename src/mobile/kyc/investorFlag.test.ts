import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INVESTOR_SELF_CERT_ENABLED } from './config';
import { PLACEHOLDER_STATEMENTS } from './kyc';

// "Qualify as an investor" stays hidden in every edition until a solicitor approves the statement wording (16 Nov 2026).
const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');

describe('investor self-certification is off', () => {
  test('the flag is false', () => {
    expect(INVESTOR_SELF_CERT_ENABLED).toBe(false);
  });

  test('the [LEGAL REVIEW] placeholder statements are empty, so they are not shipped', () => {
    expect(PLACEHOLDER_STATEMENTS).toEqual([]);
  });

  test('Settings › Identity: the investor section and the ?investor deep link sit behind the flag', () => {
    const s = src('IdentityVerification.tsx');
    expect(s).toContain('{INVESTOR_SELF_CERT_ENABLED && verified && (');
    expect(s).toContain("INVESTOR_SELF_CERT_ENABLED && query === 'investor'");
    // The section is the only place the button and the placeholder are drawn.
    expect(
      s.indexOf('Qualify as an investor', s.indexOf('{INVESTOR_SELF_CERT_ENABLED && verified && (')),
    ).toBeGreaterThan(-1);
    expect(s.indexOf('{INVESTOR_SELF_CERT_ENABLED && verified && (')).toBeLessThan(s.indexOf('[LEGAL REVIEW]'));
  });

  test('bShares: no "Self-certify as investor" button without the flag', () => {
    const s = src('../placement/SharesList.tsx');
    const gate = s.indexOf('{INVESTOR_SELF_CERT_ENABLED && (');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(s.indexOf("handleSelect('settings', 'investor')"));
  });
});
