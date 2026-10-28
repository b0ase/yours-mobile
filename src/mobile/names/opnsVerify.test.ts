import { describe, expect, it } from 'vitest';
import { fetchOpnsIndex, opnsVerdict, verdictText } from './opnsVerify';

const REAL = '48fc5bf73ed37565dd7c619f5fd88fd67f85e55e7284f98de91aa437015b14ec_2';
const GIFT = 'c3f7189432e4350b61c35c77433960cad528f011c85ca6b75cc4561c5d08c5e3_0';
const ME = '1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z';
const THEM = '1Njf8xR9RVqaoAAVxCBbEjHzDQnnhkCKsX';

describe('opnsVerdict', () => {
  it('verified when the index outpoint is this NFT (genuine name, origin matches)', () => {
    expect(opnsVerdict({ outpoint: REAL, origin: REAL, owner: THEM }, { outpoint: REAL.replace('_', '.') }, [])).toBe(
      'verified',
    );
  });
  it('verified when the index owner is one of our addresses', () => {
    expect(opnsVerdict({ outpoint: REAL, origin: REAL, owner: ME }, { outpoint: GIFT }, [ME])).toBe('verified');
  });
  it('not-yours only when another owner AND a traced origin that differs', () => {
    expect(opnsVerdict({ outpoint: REAL, origin: REAL, owner: THEM }, { outpoint: GIFT, origin: GIFT }, [ME])).toBe(
      'not-yours',
    );
  });
  it('unverified (never counterfeit) when the origin cannot be traced: may be index lag', () => {
    expect(opnsVerdict({ outpoint: REAL, origin: REAL, owner: THEM }, { outpoint: GIFT }, [ME])).toBe('unverified');
  });
  it('unverified when the index is unreachable', () => {
    expect(opnsVerdict(null, { outpoint: GIFT, origin: GIFT }, [ME])).toBe('unverified');
    expect(verdictText('unverified', 'aaap')).toMatch(/Can't verify yet/);
    expect(verdictText('unverified', 'aaap')).not.toMatch(/You own it/);
  });
  it('fetchOpnsIndex returns null on network error or HTTP error', async () => {
    expect(await fetchOpnsIndex(async () => Promise.reject(new Error('offline')), 'aaap')).toBeNull();
    expect(await fetchOpnsIndex(async () => new Response('', { status: 503 }), 'aaap')).toBeNull();
    const r = await fetchOpnsIndex(
      async () => new Response(JSON.stringify({ outpoint: REAL, origin: REAL, owner: THEM })),
      'aaap',
    );
    expect(r).toEqual({ outpoint: REAL, origin: REAL, owner: THEM });
  });
});
