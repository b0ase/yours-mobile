import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { artistSlug, groupByArtist } from './artistGroups';
import { playAlbum, libraryNowPlaying, closeLibrary } from './libraryPlayer';
import { getState, subscribe } from '../player';

const theme = {
  bg: '#101014',
  surface: '#3A3F55',
  accent: '#E0337A',
  accent2: '#6A7FA0',
  text: '#F4F4F6',
  muted: '#B8BCC8',
};
const album = (id: string, artist?: string) => ({
  id,
  title: id,
  ...(artist ? { artist } : {}),
  cover: `https://s.example/${id}.jpg`,
  theme,
  tracks: [
    { id: 't1', title: 'One', url: `https://s.example/${id}/1.mp3` },
    { id: 't2', title: 'Two', url: `https://s.example/${id}/2.mp3` },
  ],
});

describe('library artists', () => {
  it('groups albums by artist and slugs match the Artists page', () => {
    const g = groupByArtist([album('a', 'NPGX'), album('b', 'VexVoid'), album('c', 'NPGX'), album('d')]);
    expect(g.map((x) => [x.slug, x.albums.length])).toEqual([
      ['npgx', 2],
      ['vexvoid', 1],
      ['various-artists', 1],
    ]);
    expect(artistSlug('VexVoid')).toBe('vexvoid');
  });
});

describe('playback is app-global', () => {
  it('keeps playing while pages mount and unmount (Home, Wallet, Chat, Media and back)', () => {
    const g = globalThis as { Audio?: unknown };
    g.Audio ??= class {
      paused = true;
      currentTime = 0;
      preload = '';
      src = '';
      addEventListener() {}
      setAttribute() {}
      removeAttribute() {}
      pause() {}
      play() {
        return Promise.resolve();
      }
    };
    playAlbum(album('x', 'NPGX'), 1);
    const first = getState().queue[getState().index]!.id;
    // Each page subscribing then unsubscribing is what navigation does to the player.
    for (let i = 0; i < 4; i++) subscribe(() => {})();
    expect(getState().queue[getState().index]!.id).toBe(first);
    expect(libraryNowPlaying()?.id).toBe('x');
    closeLibrary();
    expect(getState().queue.length).toBe(0);
    expect(libraryNowPlaying()).toBeNull();
  });

  it('no page stops or pauses the player when it unmounts', () => {
    const root = path.join(import.meta.dir, '../..');
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (/useEffect\(\s*\(\)\s*=>\s*\(\)\s*=>\s*(void\s+)?(stop|pauseAudio|closeLibrary)\(/.test(src)) bad.push(p);
        }
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
