/**
 * Review 4 (22 Nov 2026): the relay's origin is only a claim, so every relay sheet and list names it as one.
 * M1: the phone-signing pad (BitsignHost). L1: Paired websites, including sessions stored with proven:true before proofs
 * stopped counting.
 */
import { describe, expect, test } from 'bun:test';
import { drawNote, pairedSiteLabel } from './claimedHost';

describe('claimed hosts', () => {
  test('the drawing pad says the drawing goes to a site that CLAIMS to be the host', () => {
    expect(drawNote('https://www.bchatx.com', false)).toBe(
      'Sends only this drawing to a site that claims to be www.bchatx.com. No keys, no payment.',
    );
    expect(drawNote('https://www.bchatx.com', true)).toBe(
      'Sends only this drawing to a site that claims to be www.bchatx.com. You approve the seal and its fee next.',
    );
  });

  test('Paired websites ignores an old proven flag', () => {
    expect(pairedSiteLabel({ origin: 'https://www.bchatx.com', proven: true } as never)).toBe(
      'claims to be www.bchatx.com',
    );
    expect(pairedSiteLabel({ origin: 'https://a.example' } as never)).toBe('claims to be a.example');
  });
});
