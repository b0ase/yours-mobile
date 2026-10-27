import { describe, expect, test } from 'bun:test';
import { siteAfterNavigation } from './tabSiteNav';

describe('siteAfterNavigation (site theme survives same-origin navigation)', () => {
  test('bmarketx sign-in redirect to /my keeps the site and moves the path', () => {
    expect(siteAfterNavigation('https://bmarketx.com', 'https://bmarketx.com/my')).toEqual({ keep: true, path: '/my' });
  });
  test('a reload of the same page keeps it', () => {
    expect(siteAfterNavigation('https://bmarketx.com', 'https://bmarketx.com/?x=1#a')).toEqual({
      keep: true,
      path: '/',
    });
  });
  test('another origin forgets it', () => {
    expect(siteAfterNavigation('https://bmarketx.com', 'https://evil.example/my')).toEqual({ keep: false });
    expect(siteAfterNavigation('https://bmarketx.com', 'https://www.bmarketx.com/my')).toEqual({ keep: false });
    expect(siteAfterNavigation('https://bmarketx.com', 'http://bmarketx.com/my')).toEqual({ keep: false });
  });
  test('no URL from Chrome, or no site, forgets it', () => {
    expect(siteAfterNavigation('https://bmarketx.com', undefined)).toEqual({ keep: false });
    expect(siteAfterNavigation(null, 'https://bmarketx.com/my')).toEqual({ keep: false });
    expect(siteAfterNavigation('https://bmarketx.com', 'not a url')).toEqual({ keep: false });
  });
});
