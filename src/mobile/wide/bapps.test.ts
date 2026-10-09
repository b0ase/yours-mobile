import { describe, expect, test } from 'bun:test';
import { bappFromPath, isPath, readWide } from './bapps';

const bmovies = {
  version: 1,
  name: 'bMovies',
  icon: '/icons/icon-192.png',
  home: '/feed',
  slots: {
    wallet: { enabled: false },
    exchange: { path: '/market', enabled: true },
    b: { enabled: true },
    feed: { path: '/feed', enabled: true },
    chat: { path: '/chat', enabled: true },
  },
  wide: {
    sections: [
      { id: 'feed', label: 'Feed', path: '/feed', icon: 'home' },
      { id: 'evil', label: 'Evil', path: 'https://evil.example/' },
      { id: 'proto', label: 'Proto', path: '//evil.example' },
      { id: 'Bad Id', label: 'X', path: '/x' },
      { id: 'chat', label: 'Chat', path: '/chat' },
    ],
    minWidth: 800,
  },
};

describe('bApp manifest reader', () => {
  test('keeps only same-origin sections with valid ids', () => {
    const w = readWide(bmovies)!;
    expect(w.sections.map((s) => s.id)).toEqual(['feed', 'chat']);
    expect(w.minWidth).toBe(800);
    expect(w.home).toBe('/feed');
    expect(w.icon).toBe('/icons/icon-192.png');
  });
  test('v1 manifest falls back to path slots', () => {
    const { wide: _w, ...v1 } = bmovies;
    expect(readWide(v1)!.sections.map((s) => s.id)).toEqual(['exchange', 'feed', 'chat']);
    expect(readWide(v1)!.minWidth).toBe(720);
  });
  test('rejects junk', () => {
    expect(readWide(null)).toBeNull();
    expect(readWide({ version: 2, name: 'x' })).toBeNull();
    for (const p of ['https://a.b/', '//a.b', '/\\a', 'javascript:x', '/a b', '']) expect(isPath(p)).toBe(false);
    expect(isPath('/home/mint?x=1')).toBe(true);
  });
  test('route → pinned bApp', () => {
    expect(bappFromPath('/m/bapp/bmovies')?.id).toBe('bmovies');
    expect(bappFromPath('/m/bapp/unknown')).toBeNull();
    expect(bappFromPath('/m/feed')).toBeNull();
  });
});
