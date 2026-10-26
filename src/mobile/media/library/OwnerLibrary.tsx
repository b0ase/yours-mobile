import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Lock, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { coverSources, fetchLibrary, UNAVAILABLE_TEXT, type LibraryAlbum, type LibraryState } from './library';
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
    // The mini player shows the track and moves on at the end of each song; tapping it opens Now Playing.
    playAlbum(albums, album, start, () => {
      navigate('/m/media');
      setNowPlayingOpen(true);
    });
  };

  const close = () => {
    setNowPlayingOpen(false);
    closeLibrary();
  };

  const album = state.status === 'ok' ? state.albums.find((a) => a.id === openAlbum) : undefined;

  return (
    <section aria-label="Private library" className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--bw-text)' }}>
        <Lock size={14} /> Private library
      </div>
      {state.status === 'loading' && (
        // A skeleton straight away: fixed-size tiles, nothing full-height, so the page scrolls while it loads.
        <div className={GRID} aria-busy="true" aria-label="Loading library">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-1">
              <div
                className="w-full aspect-square rounded-md animate-pulse"
                style={{ background: 'var(--bw-surface)' }}
              />
              <div className="h-3 w-2/3 rounded animate-pulse" style={{ background: 'var(--bw-surface)' }} />
            </div>
          ))}
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
      {state.status === 'ok' && !album && (
        <div className={GRID}>
          {state.albums.map((a) => (
            <button
              key={a.id}
              onClick={() => setOpenAlbum(a.id)}
              className="flex flex-col gap-1 text-left min-w-0"
              aria-label={`Open ${a.title}`}
            >
              <Cover album={a} small />
              <span className="text-sm truncate" style={{ color: 'var(--bw-text)' }}>
                {a.title}
              </span>
            </button>
          ))}
        </div>
      )}
      {album && (
        <div className="flex flex-col gap-3 min-w-0" aria-label={album.title} role="region">
          <button
            onClick={() => setOpenAlbum(null)}
            className="self-start flex items-center gap-1 text-sm"
            style={{ color: 'var(--bw-accent)' }}
          >
            <ChevronLeft size={16} /> Library
          </button>
          <div className="w-full max-w-[420px] mx-auto">
            <Cover album={album} />
          </div>
          <div className="min-w-0">
            <div className="text-lg font-semibold break-words" style={{ color: 'var(--bw-text)' }}>
              {album.title}
            </div>
            <div className="text-xs" style={{ color: 'var(--bw-muted)' }}>
              {[album.artist, `${album.tracks.length} ${album.tracks.length === 1 ? 'song' : 'songs'}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
          <div className="flex flex-col rounded-lg overflow-hidden" style={{ background: 'var(--bw-surface)' }}>
            {album.tracks.length === 0 && (
              <div className="p-3 text-sm" style={{ color: 'var(--bw-muted)' }}>
                No tracks uploaded yet.
              </div>
            )}
            {album.tracks.map((t, i) => (
              <button
                key={t.id}
                onClick={() => void play(album.id, i)}
                className="flex items-center gap-3 px-3 py-2.5 text-left min-w-0"
                style={{ borderTop: i ? '1px solid var(--bw-line)' : 'none', color: 'var(--bw-text)' }}
              >
                <span className="w-5 text-xs tabular-nums shrink-0" style={{ color: 'var(--bw-muted)' }}>
                  {i + 1}
                </span>
                <span className="flex-1 min-w-0 truncate text-sm">{t.title}</span>
                {t.duration ? (
                  <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--bw-muted)' }}>
                    {mmss(t.duration)}
                  </span>
                ) : null}
                <Play size={14} className="shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
      {playing && <NowPlaying onClose={close} />}
    </section>
  );
};

const GRID = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3';

/** m:ss from the manifest's duration; the audio itself is never fetched to find it. */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * One album cover. The shelf prefers the small thumbnail and falls back to the full cover, then to a plain tile:
 * each cover fails on its own, never holding up the others. Lazy, async-decoded, in a fixed square box.
 */
const Cover = ({ album, small }: { album: LibraryAlbum; small?: boolean }) => {
  const sources = coverSources(album, small);
  const [i, setI] = useState(0);
  const src = sources[i];
  return src ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading={small ? 'lazy' : 'eager'}
      decoding="async"
      width={small ? 400 : 800}
      height={small ? 400 : 800}
      onError={() => setI((n) => n + 1)}
      className="w-full h-auto aspect-square object-cover rounded-md block"
      style={{ background: 'var(--bw-surface)' }}
    />
  ) : (
    <div className="w-full aspect-square rounded-md" style={{ background: 'var(--bw-surface)' }} aria-hidden />
  );
};

export default OwnerLibrary;
