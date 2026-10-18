import { describe, expect, test } from 'bun:test';
import { lineItemLabel } from './sendLineItemLabel';

describe('lineItemLabel', () => {
  test('shows text labels in full', () => {
    expect(lineItemLabel('Inscribe "bWalletX mint test: video"')).toBe('Inscribe "bWalletX mint test: video"');
    expect(lineItemLabel('Network fee (est.)')).toBe('Network fee (est.)');
    expect(lineItemLabel('bWallet mint fee (1%)')).toBe('bWallet mint fee (1%)');
  });
  test('middle-truncates long addresses', () => {
    expect(lineItemLabel('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toBe('1BoatSLR...3LETtpyT');
    expect(lineItemLabel('short')).toBe('short');
  });
});
