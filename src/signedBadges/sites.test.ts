import { describe, expect, test } from 'bun:test';
import { textWithAlts } from './content/adapters';
import {
  badgeSiteFor,
  isXUserHandle,
  platformFor,
  xHandleFromProfileHref,
  xHandleFromUrl,
  xStatusIdFromUrl,
} from './sites';

describe('badge sites', () => {
  test.each([
    ['x.com', 'X'],
    ['twitter.com', 'X'],
    ['mobile.x.com', 'X'],
    ['www.linkedin.com', 'LinkedIn'],
    ['github.com', 'GitHub'],
    ['www.youtube.com', 'YouTube'],
    ['docs.google.com', undefined],
    ['evilx.com', undefined],
    ['x.com.evil.io', undefined],
    ['gist.github.com', undefined],
  ])('%s → %p', (host, site) => expect(badgeSiteFor(host)).toBe(site as never));
  test('platformFor names other hosts by host', () => {
    expect(platformFor('x.com')).toBe('X');
    expect(platformFor('www.example.org')).toBe('example.org');
  });
});

describe('X addresses', () => {
  test('status id and handle from a post address', () => {
    expect(xStatusIdFromUrl('https://x.com/ProjectBabbage/status/2116661015484178533')).toBe('2116661015484178533');
    expect(xStatusIdFromUrl('https://twitter.com/a_b/status/1/photo/1')).toBe('1');
    expect(xStatusIdFromUrl('https://x.com/a/status/12?s=20')).toBe('12');
    expect(xStatusIdFromUrl('https://x.com/a/statuses/12')).toBeUndefined();
    expect(xStatusIdFromUrl('https://evil.com/x.com/a/status/12')).toBeUndefined();
    expect(xStatusIdFromUrl('http://x.com/a/status/12')).toBeUndefined();
    expect(xHandleFromUrl('https://x.com/ProjectBabbage/status/2116661015484178533')).toBe('ProjectBabbage');
  });
  test('signed-in user from the profile tab link', () => {
    expect(xHandleFromProfileHref('/b0asex')).toBe('b0asex');
    expect(xHandleFromProfileHref('https://x.com/b0asex')).toBe('b0asex');
    expect(xHandleFromProfileHref('/b0asex/status/1')).toBeUndefined();
    expect(xHandleFromProfileHref(null)).toBeUndefined();
  });
  test('reserved paths are not handles', () => {
    expect(isXUserHandle('i')).toBe(false);
    expect(isXUserHandle('home')).toBe(false);
    expect(isXUserHandle('alice')).toBe(true);
    expect(isXUserHandle(undefined)).toBe(false);
  });
});

/** Minimal DOM-like nodes (no DOM in bun test): text = 3, element = 1. */
const text = (v: string) => ({ nodeType: 3, nodeValue: v, childNodes: [] as unknown[] });
const elem = (tagName: string, children: unknown[] = [], attrs: Record<string, string> = {}) => ({
  nodeType: 1,
  tagName,
  childNodes: children,
  getAttribute: (k: string) => attrs[k] ?? null,
  hasAttribute: (k: string) => k in attrs,
});

describe('textWithAlts', () => {
  test('keeps emoji image alt text and <br> line breaks, skips our own badge', () => {
    const post = elem('DIV', [
      elem('SPAN', [text('Jeff gets it ')]),
      elem('IMG', [], { alt: '😎' }),
      elem('BR'),
      elem('SPAN', [text('next line')]),
      elem('SPAN', [text('✓ signed')], { 'data-bwx-sb': '' }),
      elem('SCRIPT', [text('ignored()')]),
    ]);
    expect(textWithAlts(post as unknown as Node)).toBe('Jeff gets it 😎\nnext line');
  });
});
