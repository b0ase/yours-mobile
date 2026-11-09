import { describe, expect, test } from 'bun:test';
import { PNEE_ICON, PNEE_TOKEN_ID } from '../notes/pnee';
import { officialToken, placeholderTokenIcon, tokenIconUrl } from './officialTokens';
import { issuerLabel, verifyIssuer } from '../issuer/issuerVerify';

const FAKE = 'aa'.repeat(32) + '_0';

describe('official tokens', () => {
  test('official PNEE (exact id, any case/separator) gets the PNEE art', () => {
    expect(officialToken(PNEE_TOKEN_ID)?.icon).toBe(PNEE_ICON);
    expect(tokenIconUrl(PNEE_TOKEN_ID.toUpperCase().replace('_', '.'), 'PNEE', null)).toBe(PNEE_ICON);
  });
  test('a lookalike "PNEE" with another id never gets the official art', () => {
    const url = tokenIconUrl(FAKE, 'PNEE', null);
    expect(url).not.toBe(PNEE_ICON);
    expect(url).toBe(placeholderTokenIcon('PNEE'));
    expect(decodeURIComponent(url)).toContain('>P</text>');
    expect(decodeURIComponent(url)).not.toMatch(/#(d4af37|FFC93C|F29A1F)/i);
  });
  test('on-chain icon wins for other tokens; placeholder is never blank', () => {
    expect(tokenIconUrl(FAKE, 'X', 'abc_0')).toContain('/abc_0');
    expect(tokenIconUrl(FAKE, '', null)).toContain('data:image/svg+xml');
    expect(decodeURIComponent(placeholderTokenIcon('<b'))).not.toContain('<b');
  });
  test('official PNEE shows as verified without fetching the mint tx', async () => {
    const f = (() => {
      throw new Error('no fetch');
    }) as unknown as typeof fetch;
    const i = await verifyIssuer(PNEE_TOKEN_ID, f);
    expect(i.status).toBe('verified');
    expect(issuerLabel(i)).toEqual({ text: 'Issued by bWalletX · official', verified: true });
  });
  test('gives every MoneyButton deploy the real logo when it has no icon of its own', () => {
    for (const id of [
      '936a9effd2fc85c47ab205cab1ae94a5d1888f8349429ac1e2c769e1e0ba5572_0',
      '52bc729cd8ee3d42066c259251577b5ad1547edf082afbd1bd6cb79f4eafbfc1_1',
      '2ccf7aa34cb78a393bb948630d3749b945f832480c04c1a6e8f7fea31cb67b5b_0',
    ]) {
      expect(tokenIconUrl(id, 'MONEYBUTTON', undefined)).toContain('cd1b6edc');
      expect(officialToken(id)).toBeNull();
    }
  });

  test('keeps the placeholder for a same-named token with another id', () => {
    expect(tokenIconUrl('ab'.repeat(32) + '_0', 'MONEYBUTTON', undefined)).toBe(placeholderTokenIcon('MONEYBUTTON'));
  });
});
