import { describe, expect, test } from 'bun:test';
import { resolveBappLink, safeBappPath } from './bappLink';
import { toPublic, toRouter } from '../url/publicUrl';

describe('bApp deep links (/bapp/<slug>?to=<path>)', () => {
  test('bchatx opens www.bchatx.com at the path', () => {
    expect(resolveBappLink('bchatx', '/u/bmovies')).toEqual({
      name: 'bChatX',
      origin: 'https://www.bchatx.com',
      url: 'https://www.bchatx.com/u/bmovies',
    });
    expect(resolveBappLink('bChatX', '/s/lounge?x=1#y')?.url).toBe('https://www.bchatx.com/s/lounge?x=1#y');
  });
  test('missing or unsafe `to` → bChatX home', () => {
    for (const to of [
      null,
      '',
      'u/bmovies',
      '//evil.com/x',
      '/\\evil.com',
      '/a//b',
      'https://evil.com/',
      'javascript:alert(1)',
      '/a b',
      '/a\nb',
      `/${'a'.repeat(600)}`,
    ])
      expect(resolveBappLink('bchatx', to)?.url).toBe('https://www.bchatx.com/');
  });
  test('unknown slug → null', () => {
    expect(resolveBappLink('evil', '/x')).toBeNull();
    expect(resolveBappLink(undefined, '/x')).toBeNull();
  });
  test('safeBappPath keeps good paths', () => {
    expect(safeBappPath('/')).toBe('/');
    expect(safeBappPath('/u/bmovies')).toBe('/u/bmovies');
  });
  test('public URL ↔ router path survives unlock (UrlSync start route)', () => {
    expect(toRouter('/bapp/bchatx', '?to=%2Fu%2Fbmovies')).toBe('/m/bapp/bchatx?to=%2Fu%2Fbmovies');
    expect(toRouter('/bapp/bchatx', '?to=/u/bmovies')).toBe('/m/bapp/bchatx?to=/u/bmovies');
    expect(toPublic('/m/bapp/bchatx', '?to=%2Fu%2Fbmovies')).toBe('/bapp/bchatx?to=%2Fu%2Fbmovies');
  });
});
