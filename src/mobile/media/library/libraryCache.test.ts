import { describe, expect, it } from 'bun:test';
import {
  CACHE_KEY,
  CACHE_MARGIN_MS,
  clearCache,
  coverPlaceholder,
  preloadCovers,
  readCache,
  writeCache,
} from './libraryCache';

const theme = {
  bg: '#101014',
  surface: '#3A3F55',
  accent: '#E0337A',
  accent2: '#6A7FA0',
  text: '#F4F4F6',
  muted: '#B8BCC8',
};
const album = (id: string, thumb = true) => ({
  id,
  title: `Album ${id}`,
  cover: `https://store.example/${id}.jpg?t=1`,
  ...(thumb ? { thumb: `https://store.example/${id}-400.jpg?t=1` } : {}),
  theme,
  tracks: [{ id: 't1', title: 'One', url: `https://store.example/${id}/1.mp3?t=1` }],
});
const mapStore = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe('library session cache', () => {
  it('serves the session until 5 minutes before expiry, from memory and from storage', () => {
    const st = mapStore();
    const now = 1_000_000;
    writeCache({ albums: [album('a')], expiresAt: now + CACHE_MARGIN_MS + 60_000 }, st);
    expect(readCache(now, st)?.albums[0]?.id).toBe('a');
    clearCache(null); // memory only gone; storage still has it
    st.m.set(CACHE_KEY, st.m.get(CACHE_KEY) ?? '');
    writeCache({ albums: [album('a')], expiresAt: now + CACHE_MARGIN_MS + 60_000 }, st);
    expect(readCache(now + 59_000, st)?.albums.length).toBe(1);
    expect(readCache(now + 61_000, st)).toBeNull();
    expect(st.m.has(CACHE_KEY)).toBe(false);
  });
  it('ignores a tampered entry', () => {
    const st = mapStore();
    clearCache(st);
    st.setItem(CACHE_KEY, JSON.stringify({ albums: [{ ...album('a'), cover: 'javascript:x' }], expiresAt: 9e15 }));
    expect(readCache(0, st)).toBeNull();
    st.setItem(CACHE_KEY, '{nope');
    expect(readCache(0, st)).toBeNull();
  });
  it('preloads each thumbnail once (the full cover when there is no thumbnail)', () => {
    const made: { src: string }[] = [];
    const make = () => {
      const i = { src: '' };
      made.push(i);
      return i;
    };
    expect(preloadCovers([album('p'), album('q', false)], make)).toBe(2);
    expect(made.map((i) => i.src)).toEqual([album('p').thumb, album('q', false).cover]);
    expect(preloadCovers([album('p')], make)).toBe(0);
  });
  it('placeholder uses the album colours, not grey', () => {
    expect(coverPlaceholder(theme)).toContain('#E0337A');
  });
});
