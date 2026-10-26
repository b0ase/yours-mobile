import { describe, expect, it } from 'bun:test';
import { fetchLibrary, isLibraryOwner, LIBRARY_ACTION, LIBRARY_PATH, parseLibrary } from './library';
import { albumAccent, albumForPlayer, albumOfTrackId, libTrackId, wearAlbum, wornAlbum } from './albumTheme';
import { currentAccentId, saveAccent, wearingSiteLook } from '../../theme/accent';
import { getCustomAccent } from '../../theme/accents';
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
});

describe('album theme', () => {
  it('builds a readable look from the palette', () => {
    const a = albumAccent(PALETTE_A, 'A');
    expect(a.bg).toBe('#101014');
    expect(a.accent).toBe('#E0337A');
    expect(contrast(a.text, a.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.muted, a.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.on, a.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('maps player state to the playing album only for library tracks', () => {
    const albums = [album('a'), album('b')];
    expect(albumOfTrackId(libTrackId('a', 't1'))).toBe('a');
    expect(albumOfTrackId('featured-1')).toBeNull();
    expect(albumForPlayer({ queue: [{ id: libTrackId('b', 't2') }], index: 0 }, albums)?.id).toBe('b');
    expect(albumForPlayer({ queue: [{ id: 'other' }], index: 0 }, albums)).toBeNull();
    expect(albumForPlayer({ queue: [], index: -1 }, albums)).toBeNull();
  });

  it('applies, keeps within an album, switches between albums and reverts to the user theme', () => {
    saveAccent('acct', 'pink');
    expect(currentAccentId()).toBe('pink');

    wearAlbum(album('a', PALETTE_A));
    expect(wornAlbum()).toBe('a');
    expect(wearingSiteLook()).toBe(true);
    expect(currentAccentId()).toBe('custom');
    expect(getCustomAccent()?.accent).toBe('#E0337A');

    // Next track, same album: nothing changes.
    wearAlbum(album('a', PALETTE_B));
    expect(getCustomAccent()?.accent).toBe('#E0337A');

    // Album changes: the palette switches.
    wearAlbum(album('b', PALETTE_B));
    expect(wornAlbum()).toBe('b');
    expect(getCustomAccent()?.accent).toBe('#C8553D');

    // Stop / close: the user's own theme comes back.
    wearAlbum(null);
    expect(wornAlbum()).toBeNull();
    expect(wearingSiteLook()).toBe(false);
    expect(currentAccentId()).toBe('pink');
  });
});
