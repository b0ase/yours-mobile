import { describe, expect, it } from 'bun:test';
import {
  cleanTitle,
  coverSources,
  fetchLibrary,
  isLibraryOwner,
  LIBRARY_ACTION,
  LIBRARY_PATH,
  parseLibrary,
} from './library';
import { albumForPlayer, albumOfTrackId, albumStyle, albumVars, libTrackId, trackOfTrackId } from './albumTheme';
import { closeLibrary, playAlbum } from './libraryPlayer';
import { getState } from '../player';
import { currentAccentId, saveAccent, wearingSiteLook } from '../../theme/accent';
import { contrast } from '../../theme/colour';

const PALETTE_A = {
  bg: '#101014',
  surface: '#3A3F55',
  accent: '#E0337A',
  accent2: '#6A7FA0',
  text: '#F4F4F6',
  muted: '#B8BCC8',
};
const PALETTE_B = { ...PALETTE_A, accent: '#C8553D', bg: '#140C0C' };
const album = (id: string, theme = PALETTE_A) => ({
  id,
  title: `Album ${id}`,
  cover: `https://store.example/sign/${id}.jpg?token=t`,
  theme,
  tracks: [
    { id: 't1', title: 'One', url: `https://store.example/sign/${id}/1.mp3?token=t` },
    { id: 't2', title: 'Two', url: `https://store.example/sign/${id}/2.mp3?token=t` },
  ],
});

describe('isLibraryOwner (cosmetic gate)', () => {
  it('matches only the owner handle, case-insensitively', () => {
    expect(isLibraryOwner('b0asex@bwalletx.com')).toBe(true);
    expect(isLibraryOwner('  B0aseX@BWalletX.com ')).toBe(true);
    expect(isLibraryOwner('b0ase@bwalletx.com')).toBe(false);
    expect(isLibraryOwner('b0asex@bmailx.com')).toBe(false);
    expect(isLibraryOwner('b0asex@bwalletx.com.evil')).toBe(false);
    expect(isLibraryOwner('')).toBe(false);
    expect(isLibraryOwner(null)).toBe(false);
    expect(isLibraryOwner(undefined)).toBe(false);
  });
});

describe('parseLibrary', () => {
  it('accepts a well-formed answer', () => {
    const r = parseLibrary({ albums: [album('a')], expiresAt: 123 });
    expect(r?.albums[0]?.tracks.length).toBe(2);
  });
  it('refuses non-https links, bad colours and markup', () => {
    expect(parseLibrary({ albums: [{ ...album('a'), cover: 'http://x/y.jpg' }], expiresAt: 1 })).toBeNull();
    expect(parseLibrary({ albums: [{ ...album('a'), cover: 'javascript:alert(1)' }], expiresAt: 1 })).toBeNull();
    expect(parseLibrary({ albums: [{ ...album('a'), theme: { ...PALETTE_A, bg: 'red' } }], expiresAt: 1 })).toBeNull();
    expect(parseLibrary({ albums: [{ ...album('a'), title: '<b>x</b>' }], expiresAt: 1 })).toBeNull();
    expect(parseLibrary({ albums: [album('a')] })).toBeNull();
    expect(parseLibrary(null)).toBeNull();
  });
  it('one failing album never blocks the others', () => {
    const r = parseLibrary({
      albums: [album('a'), { ...album('b'), cover: 'http://x/y.jpg' }, { ...album('c'), theme: null }, album('d')],
      expiresAt: 1,
    });
    expect(r?.albums.map((a) => a.id)).toEqual(['a', 'd']);
    const t = parseLibrary({
      albums: [{ ...album('a'), tracks: [...album('a').tracks, { id: 't3', title: 'x', url: 'http://bad' }] }],
      expiresAt: 1,
    });
    expect(t?.albums[0]?.tracks.map((x) => x.id)).toEqual(['t1', 't2']);
  });
  it('prefers a thumbnail on the shelf when present, else the full cover', () => {
    const r = parseLibrary({ albums: [{ ...album('a'), thumb: 'https://store.example/a-400.jpg' }], expiresAt: 1 });
    const a = r!.albums[0]!;
    expect(coverSources(a, true)).toEqual(['https://store.example/a-400.jpg', a.cover]);
    expect(coverSources(a)).toEqual([a.cover]);
    expect(coverSources(album('b'), true)).toEqual([album('b').cover]);
    expect(parseLibrary({ albums: [{ ...album('a'), thumb: 'javascript:x' }], expiresAt: 1 })!.albums[0]!.thumb).toBe(
      undefined,
    );
  });
});

describe('cleanTitle', () => {
  it('turns file-name titles into song titles and leaves real ones alone', () => {
    expect(cleanTitle('01 - night_drive.mp3')).toBe('Night Drive');
    expect(cleanTitle('03. some-song')).toBe('Some Song');
    expect(cleanTitle('7_LOUD_THING')).toBe('Loud Thing');
    expect(cleanTitle('Already Fine')).toBe('Already Fine');
    expect(cleanTitle('Song (feat. Someone)')).toBe('Song (feat. Someone)');
  });
});

describe('fetchLibrary (server is the lock)', () => {
  const wallet = {
    getPublicKey: async () => ({ publicKey: '02'.padEnd(66, 'a') }),
    createSignature: async () => ({ signature: [1, 2, 3] }),
  } as never;

  it('is unavailable with no server configured, without any request', async () => {
    let called = false;
    const r = await fetchLibrary(
      async () => {
        called = true;
        return new Response('{}');
      },
      wallet,
      '',
    );
    expect(r).toEqual({ status: 'unavailable', reason: 'not_configured' });
    expect(called).toBe(false);
  });

  it('sends a signed request and maps a refusal to "denied"', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const r = await fetchLibrary(
      async (url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return new Response('{"error":"forbidden"}', { status: 403 });
      },
      wallet,
      'https://pay.example',
    );
    expect(r).toEqual({ status: 'unavailable', reason: 'denied' });
    expect(seen!.url).toBe(`https://pay.example${LIBRARY_PATH}`);
    expect(seen!.body.identityKey).toBeTruthy();
    expect(seen!.body.signature).toBe('010203');
    expect(typeof seen!.body.timestamp).toBe('number');
    expect(LIBRARY_ACTION).toBe('library-session');
  });

  it('returns albums on success and "invalid" on a bad answer', async () => {
    const ok = await fetchLibrary(
      async () => new Response(JSON.stringify({ albums: [album('a')], expiresAt: 9 })),
      wallet,
      'https://pay.example',
    );
    expect(ok.status).toBe('ok');
    const bad = await fetchLibrary(async () => new Response('{"albums":5}'), wallet, 'https://pay.example');
    expect(bad).toEqual({ status: 'unavailable', reason: 'invalid' });
    const off = await fetchLibrary(
      async () => {
        throw new Error('offline');
      },
      wallet,
      'https://pay.example',
    );
    expect(off).toEqual({ status: 'unavailable', reason: 'network' });
  });
  it('a request that never answers ends as "network", not loading for ever', async () => {
    const hung = await fetchLibrary(() => new Promise<Response>(() => {}), wallet, 'https://pay.example', 20);
    expect(hung).toEqual({ status: 'unavailable', reason: 'network' });
  });
});

describe('album theme (scoped to the player only)', () => {
  it('builds readable player variables from the palette', () => {
    const v = albumVars(PALETTE_A);
    expect(v['--bw-bg']).toBe('#101014');
    expect(v['--bw-accent']).toBe('#E0337A');
    expect(contrast(v['--bw-text']!, v['--bw-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v['--bw-muted']!, v['--bw-surface']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v['--bw-on-accent']!, v['--bw-accent']!)).toBeGreaterThanOrEqual(4.5);
    expect(v['--bw-accent-hi-rgb']).toMatch(/^\d+ \d+ \d+$/);
    expect((albumStyle(PALETTE_A) as Record<string, string>).background).toBe('var(--bw-bg)');
  });

  it('maps player state to the playing album only for library tracks', () => {
    const albums = [album('a'), album('b')];
    expect(albumOfTrackId(libTrackId('a', 't1'))).toBe('a');
    expect(trackOfTrackId(libTrackId('a', 't1'))).toBe('t1');
    expect(trackOfTrackId('featured-1')).toBeNull();
    expect(albumOfTrackId('featured-1')).toBeNull();
    expect(albumForPlayer({ queue: [{ id: libTrackId('b', 't2') }], index: 0 }, albums)?.id).toBe('b');
    expect(albumForPlayer({ queue: [{ id: 'other' }], index: 0 }, albums)).toBeNull();
    expect(albumForPlayer({ queue: [], index: -1 }, albums)).toBeNull();
  });

  it('playback leaves the global theme untouched, and close leaves nothing behind', () => {
    // A stand-in <audio> element: the player needs one; no sound is played here.
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
    saveAccent('acct', 'pink');
    const root = typeof document !== 'undefined' ? document.documentElement.getAttribute('style') : null;
    playAlbum(album('a', PALETTE_A), 0);
    expect(getState().queue.length).toBe(2);
    expect(currentAccentId()).toBe('pink');
    expect(wearingSiteLook()).toBe(false);
    playAlbum(album('b', PALETTE_B), 1);
    expect(currentAccentId()).toBe('pink');
    expect(wearingSiteLook()).toBe(false);
    closeLibrary();
    expect(getState().queue.length).toBe(0);
    expect(getState().index).toBe(-1);
    expect(currentAccentId()).toBe('pink');
    expect(wearingSiteLook()).toBe(false);
    if (typeof document !== 'undefined') expect(document.documentElement.getAttribute('style')).toBe(root);
  });
});
