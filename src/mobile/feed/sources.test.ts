import { describe, expect, test } from 'bun:test';
import { SOURCE_REGISTRY, SOURCES, sourceInfo, sourceLabel, sourceOf, sourceUrl, type Source } from './sources';

const TX = 'ab'.repeat(32);
const THREAD = '0f6c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

describe('source registry', () => {
  test('every source has a label, a bundled icon and a postUrl', () => {
    for (const id of Object.keys(SOURCE_REGISTRY) as Source[]) {
      const s = SOURCE_REGISTRY[id];
      expect(s.id).toBe(id);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.icon).toMatch(/\.png$/);
      expect(s.icon).not.toMatch(/^https?:/);
      expect(typeof s.postUrl).toBe('function');
    }
    expect(SOURCES.map((s) => s.id)).toEqual(['all', 'bwallet', 'treechat', 'twetch', 'other']);
  });
  test('matching MAP app values', () => {
    expect(sourceOf(' bWallet ')).toBe('bwallet');
    expect(sourceOf('treechat_staging')).toBe('treechat');
    expect(sourceOf('TWETCH')).toBe('twetch');
    expect(sourceOf('peck.agents')).toBe('other');
    expect(sourceInfo('twetch').label).toBe('Twetch');
    expect(sourceLabel('bsocial')).toBe('bSocial');
    expect(sourceLabel('bWallet')).toBe('');
  });
  test('original-post links', () => {
    expect(sourceUrl({ source: 'treechat', threadId: THREAD, txid: TX })).toBe(`https://app.treechat.com/p/${THREAD}`);
    expect(sourceUrl({ source: 'treechat', threadId: null, txid: TX })).toBeNull();
    expect(sourceUrl({ source: 'twetch', threadId: null, txid: TX })).toBe(`https://twetch.com/t/${TX}`);
    expect(sourceUrl({ source: 'bwallet', threadId: null, txid: TX })).toBeNull();
    expect(sourceUrl({ source: 'other', threadId: null, txid: TX })).toBeNull();
  });
});
