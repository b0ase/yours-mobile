import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, Lock, Pause, Play } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { coverSources, fetchLibrary, UNAVAILABLE_TEXT, type LibraryAlbum, type LibraryState } from './library';
import { playAlbum, setNowPlayingOpen } from './libraryPlayer';
import { getState, subscribe, toggle } from '../player';
import { AlbumHeader, AlbumPlayButton, AlbumTrackRow } from '../AlbumParts';
import { albumFmt } from '../albumLayout';
import { albumOfTrackId, albumStyle, trackOfTrackId } from './albumTheme';
import { clearCache, coverPlaceholder, preloadCovers, readCache, usable, writeCache } from './libraryCache';

const f = (u: string, i?: RequestInit) => fetch(u, i);
// A cached session with less than this left is refreshed in the background while the cached shelf shows.
const REFRESH_WITHIN_MS = 20 * 60_000;

/** Asks the server, remembers a good answer (and warms the covers), forgets the cache on a refusal. */
const ask = async (wallet: Parameters<typeof fetchLibrary>[1]): Promise<LibraryState> => {
  const next = await fetchLibrary(f, wallet);
  if (next.status === 'ok') {
    writeCache(next);
    preloadCovers(next.albums);
  } else if (next.status === 'unavailable' && next.reason === 'denied') clearCache();
  return next;
};
const cachedState = (): LibraryState => {
  const c = readCache();
  if (c) preloadCovers(c.albums);
  return c ? { status: 'ok', ...c } : { status: 'loading' };
};

/**
 * The owner's private library shelf on /m/media (lazy chunk; only mounted when useLibraryOwner says so). Everything
 * shown here comes from the server's signed answer at run time; nothing is bundled. Covers wrap in a grid (no
 * sideways scrolling); tapping one lists its tracks, and a track opens Now Playing.
 */
const OwnerLibrary = () => {
  const { apiContext } = useServiceContext();
  const location = useLocation();
  const [state, setState] = useState<LibraryState>(cachedState);
  const [openAlbum, setOpenAlbum] = useState<string | null>(
    () => (location.state as { libraryAlbum?: string } | null)?.libraryAlbum ?? null,
  );
  const [player, setPlayer] = useState(getState);
  useEffect(() => subscribe(setPlayer), []);

  const load = useCallback(async () => {
    const c = readCache();
    if (c) {
      // The cached shelf is already on screen; only refresh, quietly, when it is getting old.
      setState({ status: 'ok', ...c });
      if (c.expiresAt - Date.now() > REFRESH_WITHIN_MS) return;
      const next = await ask(apiContext.wallet);
      if (next.status === 'ok' || (next.status === 'unavailable' && next.reason === 'denied')) setState(next);
      return;
    }
    setState({ status: 'loading' });
    setState(await ask(apiContext.wallet));
  }, [apiContext.wallet]);
  useEffect(() => {
    void load();
  }, [load]);

  const fresh = async (): Promise<LibraryAlbum[] | null> => {
    if (state.status === 'ok' && usable(state)) return state.albums;
    const next = await ask(apiContext.wallet);
    setState(next);
    return next.status === 'ok' ? next.albums : null;
  };

  const play = async (albumId: string, start: number) => {
    const albums = await fresh();
    const album = albums?.find((a) => a.id === albumId);
    if (!albums || !album) return;
    // The mini player shows the track and moves on at the end of each song; tapping it opens Now Playing.
    playAlbum(album, start);
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
        // The album page: the VexVoid album's layout (AlbumParts) in this album's colours, scoped to this box only.
        <div
          className="flex flex-col min-w-0"
          aria-label={album.title}
          role="region"
          style={{
            ...albumStyle(album.theme),
            border: '1px solid var(--bw-line)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <button
            onClick={() => setOpenAlbum(null)}
            className="self-start flex items-center gap-1 text-sm px-4 pt-3"
            style={{ color: 'var(--bw-accent-hi)' }}
          >
            <ChevronLeft size={16} /> Library
          </button>
          {(() => {
            const here = albumOfTrackId(player.queue[player.index]?.id) === album.id;
            const current = here ? trackOfTrackId(player.queue[player.index]?.id) : null;
            const total = album.tracks.reduce((n, t) => n + (t.duration ?? 0), 0);
            return (
              <>
                <AlbumHeader
                  cover={<Cover album={album} />}
                  title={album.title}
                  byline={
                    <span>
                      {[
                        album.artist,
                        `${album.tracks.length} ${album.tracks.length === 1 ? 'track' : 'tracks'}`,
                        total ? `${Math.max(1, Math.round(total / 60))} min` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  }
                >
                  {album.tracks.length > 0 && (
                    <div className="mt-2 flex items-center gap-3">
                      <AlbumPlayButton
                        playing={here && player.playing}
                        label={here && player.playing ? 'Pause' : here ? 'Play' : 'Play album'}
                        icon={here && player.playing ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
                        onClick={() => (here ? toggle() : void play(album.id, 0))}
                      />
                      {here && (
                        <button
                          onClick={() => setNowPlayingOpen(true)}
                          className="text-sm underline-offset-4 hover:underline"
                          style={{ color: 'var(--bw-accent-hi)' }}
                        >
                          Now playing
                        </button>
                      )}
                    </div>
                  )}
                </AlbumHeader>
                <div
                  className="flex flex-col px-4 md:px-6 pb-4 md:pb-6"
                  style={{ borderTop: '1px solid var(--bw-line)' }}
                >
                  {album.tracks.length === 0 && (
                    <div className="py-2 text-sm" style={{ color: 'var(--bw-muted)' }}>
                      No tracks uploaded yet.
                    </div>
                  )}
                  {album.tracks.map((t, i) => (
                    <AlbumTrackRow
                      key={t.id}
                      n={i + 1}
                      active={current === t.id}
                      playing={player.playing}
                      thumb={album.thumb ?? album.cover}
                      title={t.title}
                      duration={t.duration ? albumFmt(t.duration) : undefined}
                      onClick={() => (current === t.id ? toggle() : void play(album.id, i))}
                    />
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </section>
  );
};

const GRID = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3';

/**
 * One album cover. The shelf shows the small thumbnail (warmed by preloadCovers). The album page shows the thumbnail
 * at once and cross-fades the full cover in over it when it has loaded. Until anything paints, the tile wears the
 * album's own colours. Each cover fails on its own; a failed image just leaves the colour tile.
 */
const Cover = ({ album, small }: { album: LibraryAlbum; small?: boolean }) => {
  const sources = coverSources(album, small);
  const first = small ? sources : album.thumb ? [album.thumb] : [];
  const [failed, setFailed] = useState(0);
  const [full, setFull] = useState(false);
  const base = first[failed];
  const img = 'absolute inset-0 w-full h-full object-cover block transition-opacity duration-500';
  return (
    <div
      className="relative w-full aspect-square rounded-md overflow-hidden"
      style={{ background: coverPlaceholder(album.theme) }}
    >
      {base && (
        <img
          src={base}
          alt=""
          referrerPolicy="no-referrer"
          loading="eager"
          decoding="async"
          width={400}
          height={400}
          onError={() => setFailed((n) => n + 1)}
          className={img}
        />
      )}
      {!small && (
        <img
          src={album.cover}
          alt=""
          referrerPolicy="no-referrer"
          loading="eager"
          decoding="async"
          width={800}
          height={800}
          onLoad={() => setFull(true)}
          className={img}
          style={{ opacity: full ? 1 : 0 }}
        />
      )}
    </div>
  );
};

export default OwnerLibrary;
