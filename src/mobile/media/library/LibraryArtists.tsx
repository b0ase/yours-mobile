import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { fetchLibrary, type LibraryAlbum } from './library';
import { coverPlaceholder, preloadCovers, readCache, writeCache } from './libraryCache';
import { groupByArtist } from './artistGroups';

/**
 * The owner's private library inside Media › Artists (owner only; MediaPage/ArtistsPage mount it behind
 * useLibraryOwner, and the server is the lock). Albums come from the signed library session, grouped by the
 * manifest's artist, and merge with the public artists: an artist that already has a page gets a "Private library"
 * section on it; the others get their own cards and pages. An album opens the library album page on /m/media.
 *   mode "cards":   artist cards for artists not in `exclude` (the Artists index)
 *   mode "section": this artist's private albums (on an existing artist's page)
 *   mode "page":    a whole artist page for a library-only artist
 */
const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';
const ROOT = '/m/media/artists';
const f = (u: string, i?: RequestInit) => fetch(u, i);

const useLibraryAlbums = (): LibraryAlbum[] | null => {
  const { apiContext } = useServiceContext();
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(() => readCache()?.albums ?? null);
  useEffect(() => {
    if (albums) return;
    let live = true;
    void fetchLibrary(f, apiContext.wallet).then((r) => {
      if (!live || r.status !== 'ok') return;
      writeCache(r);
      preloadCovers(r.albums);
      setAlbums(r.albums);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiContext.wallet]);
  return albums;
};

const Tile = ({ album, size }: { album: LibraryAlbum; size: number }) => (
  <div
    className="aspect-square rounded-xl overflow-hidden"
    style={{ width: size, background: coverPlaceholder(album.theme) }}
  >
    <img
      src={album.thumb ?? album.cover}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      className="w-full h-full object-cover block"
    />
  </div>
);

const Albums = ({ albums }: { albums: LibraryAlbum[] }) => {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-4">
      {albums.map((a) => (
        <button
          key={a.id}
          onClick={() => navigate('/m/media', { state: { libraryAlbum: a.id } })}
          className="text-left"
          style={{ width: 160 }}
        >
          <Tile album={a} size={160} />
          <div className="mt-2 text-sm font-bold text-white truncate">{a.title}</div>
          <div className="text-[12px]" style={{ color: MUTED }}>
            {a.tracks.length} tracks
          </div>
        </button>
      ))}
    </div>
  );
};

export default function LibraryArtists({
  mode,
  slug,
  exclude = [],
}: {
  mode: 'cards' | 'section' | 'page';
  slug?: string;
  exclude?: string[];
}) {
  const navigate = useNavigate();
  const albums = useLibraryAlbums();
  if (!albums) return null;
  const artists = groupByArtist(albums);
  if (mode === 'cards')
    return (
      <>
        {artists
          .filter((g) => !exclude.includes(g.slug))
          .map((g) => (
            <button
              key={g.slug}
              onClick={() => navigate(`${ROOT}/${g.slug}`)}
              className="text-left"
              style={{ width: 220 }}
            >
              <Tile album={g.albums[0]!} size={220} />
              <div className="mt-2 font-bold text-white">{g.name}</div>
              <div className="text-[13px] flex items-center gap-1" style={{ color: MUTED }}>
                <Lock size={11} /> {g.albums.length} private release{g.albums.length === 1 ? '' : 's'}
              </div>
              <span className="text-sm font-bold" style={{ color: GOLD }}>
                Listen
              </span>
            </button>
          ))}
      </>
    );
  const g = artists.find((x) => x.slug === slug);
  if (!g) return null;
  const section = (
    <div className="mt-8">
      <div
        className="flex items-center gap-2 text-[12px] font-bold tracking-[.18em] uppercase mb-3"
        style={{ color: GOLD }}
      >
        <Lock size={12} /> Private library
      </div>
      <Albums albums={g.albums} />
    </div>
  );
  if (mode === 'section') return <div className="px-4 pb-6 max-w-5xl mx-auto w-full">{section}</div>;
  return (
    <div className="px-4 py-6 max-w-5xl mx-auto w-full text-white">
      <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
        Artist
      </div>
      <h2 className="text-4xl font-bold mt-2 mb-1">{g.name}</h2>
      {section}
    </div>
  );
}
