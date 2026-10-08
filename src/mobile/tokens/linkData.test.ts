import { describe, expect, it } from 'vitest';
import { parseLinks, safeHttps, toLink } from './linkData';

describe('token links', () => {
  it('shows nothing for a plain deploy inscription', () => {
    expect(parseLinks({ p: 'bsv-20', op: 'deploy+mint', amt: '1000', sym: 'X', icon: '_0' })).toEqual([]);
    expect(parseLinks(null, undefined, 'x')).toEqual([]);
  });
  it('accepts https only, with the domain as label', () => {
    expect(toLink('website', 'https://www.frogger.game/play')).toEqual({
      kind: 'website',
      url: 'https://www.frogger.game/play',
      label: 'frogger.game',
    });
    for (const bad of ['http://a.com', 'javascript:alert(1)', 'https://u:p@a.com', 'https://localhost', 'https://1.2.3.4', 'data:text/html,x'])
      expect(toLink('website', bad)).toBeNull();
    expect(safeHttps('ftp://a.com')).toBeNull();
  });
  it('turns handles into X / Telegram profile URLs and pins their domains', () => {
    expect(toLink('x', '@b0ase')?.url).toBe('https://x.com/b0ase');
    expect(toLink('telegram', 'frogger')?.url).toBe('https://t.me/frogger');
    expect(toLink('x', 'https://twitter.com/b0ase')?.label).toBe('twitter.com');
    expect(toLink('x', 'https://evil.com/b0ase')).toBeNull();
    expect(toLink('telegram', 'https://t.me.evil.com/x')).toBeNull();
  });
  it('reads nested links, first source wins, fixed order', () => {
    const l = parseLinks(
      { links: { telegram: '@tg', website: 'https://a.io' } },
      { website: 'https://b.io', x: '@xx', app: 'https://app.a.io' },
    );
    expect(l.map((x) => [x.kind, x.label])).toEqual([
      ['website', 'a.io'],
      ['app', 'app.a.io'],
      ['x', '@xx'],
      ['telegram', '@tg'],
    ]);
  });
});

describe('excluded fields', () => {
  it('never shows company / equity fields', () => {
    expect(parseLinks({ company: 'https://acme.com', equity: 'https://acme.com', shares: '10%' })).toEqual([]);
  });
});

describe('utility', () => {
  it('is plain, single-line, capped, first source wins', async () => {
    const { parseUtility, UTILITY_MAX } = await import('./linkData');
    expect(parseUtility({ sym: 'X' })).toBeNull();
    expect(parseUtility({ utility: ' Ammo\nfor‮Chain Frogger ' }, { utility: 'other' })).toBe('Ammo for Chain Frogger');
    expect(parseUtility({ utility: 'a'.repeat(500) })!.length).toBe(UTILITY_MAX);
  });
});
