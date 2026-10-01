import { describe, expect, test } from 'bun:test';
import {
  REMOTE_ACTIONS,
  SOURCE_REGISTRY,
  SOURCES,
  actionLabel,
  postActions,
  sourceInfo,
  sourceLabel,
  sourceOf,
  sourceUrl,
  type Source,
} from './sources';

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

  test('per-source actions', () => {
    for (const id of Object.keys(SOURCE_REGISTRY) as Source[]) {
      const { row, more } = SOURCE_REGISTRY[id].actions;
      expect(row.length).toBeGreaterThan(0);
      expect(row.length).toBeLessThanOrEqual(5); // the row stays clean
      expect(new Set([...row, ...more]).size).toBe(row.length + more.length);
    }
    const tw = postActions({ source: 'twetch', threadId: null, txid: TX });
    for (const a of ['reply', 'like', 'branch', 'quote', 'tip', 'lock', 'copyLink', 'open', 'report', 'mute'] as const)
      expect([...tw.row, ...tw.more]).toContain(a);
    expect(tw.row).toEqual(['reply', 'like', 'branch', 'tip', 'lock']);
    expect(tw.more).toContain('bookmark');
    expect(tw.more).toContain('unlock');
    expect(REMOTE_ACTIONS.has('bookmark') && REMOTE_ACTIONS.has('unlock')).toBe(true);
    expect(actionLabel('open', 'twetch')).toBe('Open in Twetch');
    expect(actionLabel('branch', 'twetch')).toBe('Branch');
  });
  test('link actions are dropped without an original-post link', () => {
    const bw = postActions({ source: 'bwallet', threadId: null, txid: TX });
    expect(bw.row).toEqual(['reply', 'like', 'tip', 'lock']);
    expect(bw.more).toEqual(['report', 'mute']);
    const tc = postActions({ source: 'treechat', threadId: THREAD, txid: TX });
    expect(tc.more).toContain('open');
    expect(postActions({ source: 'treechat', threadId: null, txid: TX }).more).not.toContain('copyLink');
  });
});
