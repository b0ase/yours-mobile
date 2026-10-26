import { useCallback, useEffect, useState } from 'react';
import { Lock, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { fetchLibrary, UNAVAILABLE_TEXT, type LibraryAlbum, type LibraryState } from './library';
import { closeLibrary, nowPlayingOpen, onNowPlayingOpen, playAlbum, setNowPlayingOpen } from './libraryPlayer';
import { NowPlaying } from './NowPlaying';

const f = (u: string, i?: RequestInit) => fetch(u, i);
// Re-ask the server a minute before the signed links run out.
const EARLY_MS = 60_000;

/**
 * The owner's private library shelf on /m/media (lazy chunk; only mounted when useLibraryOwner says so). Everything
 * shown here comes from the server's signed answer at run time; nothing is bundled. Covers wrap in a grid (no
 * sideways scrolling); tapping one lists its tracks, and a track opens Now Playing.
 */
const OwnerLibrary = () => {
  const { apiContext } = useServiceContext();
  const navigate = useNavigate();
  const [state, setState] = useState<LibraryState>({ status: 'loading' });
  const [openAlbum, setOpenAlbum] = useState<string | null>(null);
  const [playing, setPlaying] = useState(nowPlayingOpen);
  useEffect(() => onNowPlayingOpen(setPlaying), []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    setState(await fetchLibrary(f, apiContext.wallet));
  }, [apiContext.wallet]);
  useEffect(() => {
    void load();
  }, [load]);

  const fresh = async (): Promise<LibraryAlbum[] | null> => {
    if (state.status === 'ok' && state.expiresAt - EARLY_MS > Date.now()) return state.albums;
    const next = await fetchLibrary(f, apiContext.wallet);
    setState(next);
    return next.status === 'ok' ? next.albums : null;
  };

  const play = async (albumId: string, start: number) => {
    const albums = await fresh();
    const album = albums?.find((a) => a.id === albumId);
    if (!albums || !album) return;
    playAlbum(albums, album, start, () => {
      navigate('/m/media');
      setNowPlayingOpen(true);
    });
    setNowPlayingOpen(true);
  };

  const close = () => {
    setNowPlayingOpen(false);
    closeLibrary();
  };

  return (
    <section aria-label="Private library" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--bw-text)' }}>
        <Lock size={14} /> Private library
      </div>
      {state.status === 'loading' && (
        <div className="text-sm" style={{ color: 'var(--bw-muted)' }}>
          Loading…
        </div>
      )}
      {state.status === 'unavailable' && (
        <div
          className="flex flex-col gap-2 p-3 rounded-lg text-sm"
          style={{ background: 'var(--bw-surface)', color: 'var(--bw-muted)' }}
        >
          <span style={{ color: 'var(--bw-text)' }}>Library unavailable</span>
          <span>{UNAVAILABLE_TEXT[state.reason]}</span>
          <button onClick={() => void load()} className="self-start underline" style={{ color: 'var(--bw-accent)' }}>
            Try again
          </button>
        </div>
      )}
      {state.status === 'ok' && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {state.albums.map((a) => (
              <button
                key={a.id}
                onClick={() => setOpenAlbum(openAlbum === a.id ? null : a.id)}
                aria-expanded={openAlbum === a.id}
                className="flex flex-col gap-1 text-left min-w-0"
              >
                <img
                  src={a.cover}
                  alt=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="w-full aspect-square object-cover rounded-md block"
                  style={{ outline: openAlbum === a.id ? '2px solid var(--bw-accent)' : 'none' }}
                />
                <span className="text-sm truncate" style={{ color: 'var(--bw-text)' }}>
                  {a.title}
                </span>
              </button>
            ))}
          </div>
          {state.albums
            .filter((a) => a.id === openAlbum)
            .map((a) => (
              <div
                key={a.id}
                className="flex flex-col rounded-lg overflow-hidden"
                style={{ background: 'var(--bw-surface)' }}
              >
                {a.tracks.length === 0 && (
                  <div className="p-3 text-sm" style={{ color: 'var(--bw-muted)' }}>
                    No tracks uploaded yet.
                  </div>
                )}
                {a.tracks.map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => void play(a.id, i)}
                    className="flex items-center gap-3 px-3 py-2.5 text-left min-w-0"
                    style={{ borderTop: i ? '1px solid var(--bw-line)' : 'none', color: 'var(--bw-text)' }}
                  >
                    <span className="w-5 text-xs tabular-nums shrink-0" style={{ color: 'var(--bw-muted)' }}>
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm">{t.title}</span>
                    <Play size={14} className="shrink-0" />
                  </button>
                ))}
              </div>
            ))}
        </>
      )}
      {playing && <NowPlaying onClose={close} />}
    </section>
  );
};

export default OwnerLibrary;
