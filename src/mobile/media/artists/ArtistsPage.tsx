import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Home } from 'lucide-react';
import { TopNav } from '../../../components/TopNav';
import { BMUSIC_HOST, SHARE_ALBUMS, type ShareAlbum } from '../../../web/shareAlbums';

/**
 * /m/media/artists and /m/media/artists/<slug> (public /bmusic/artists[/<slug>]): the artist screens inside the
 * app shell (owner, 12 Oct 2026: "in app, not loose pages"). Same content as the old static pages: artist cards;
 * cover, bio, tracks with live original prices, the sponsor pot and top listeners from the bMusic server.
 * bWalletX only: MobileRoutes mounts it behind PAY_STREAM_ENABLED, so a store build has no prices in it.
 */
const GOLD = '#FFD24D';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const HOME = '/m/media';
const ROOT = '/m/media/artists';

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const bsv = (s: number) => `${(s / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} BSV`;
const getJson = <T,>(p: string): Promise<T | null> =>
  fetch(BMUSIC_HOST + p)
    .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
    .catch(() => null);

const ARTISTS: ShareAlbum[][] = [...new Set(SHARE_ALBUMS.map((a) => a.artistSlug))].map((slug) =>
  SHARE_ALBUMS.filter((a) => a.artistSlug === slug),
);
const coverOf = (a: ShareAlbum) => a.artistCover ?? `/bmusic/covers/${a.artistSlug}-${a.slug}.jpg`;
const trackId = (a: ShareAlbum, i: number) => `${a.id}-${String(i + 1).padStart(2, '0')}`;

type Release = { minted?: boolean; forSale?: boolean; mintPriceSats?: number };
type Listener = { handle?: string; name?: string; paymail?: string; identityKey?: string; secondsTotal?: number };
type Board = { listeners?: Listener[]; anonCount?: number };
type Pot = { potSats?: number; capSats?: number; sponsored?: boolean };

const Price = ({ id, site }: { id: string; site?: string }) => {
  const [r, setR] = useState<Release | null>(null);
  useEffect(() => {
    void getJson<Release>(`/api/bmusic/release/${id}`).then(setR);
  }, [id]);
  if (!r) return null;
  if (r.minted)
    return (
      <div className="text-[12px]" style={{ color: MUTED }}>
        Original owned
      </div>
    );
  if (!r.forSale || !r.mintPriceSats || !site) return null;
  return (
    <a href={site} target="_blank" rel="noopener noreferrer" className="text-[12px]" style={{ color: GOLD }}>
      Buy the original · {bsv(r.mintPriceSats)}
    </a>
  );
};

const Bar = ({ title, slug }: { title?: string; slug?: boolean }) => {
  const navigate = useNavigate();
  return (
    <div
      className="sticky top-14 z-10 flex items-center gap-2 px-2 py-1"
      style={{ background: '#010101', borderBottom: `1px solid ${LINE}` }}
    >
      <button aria-label="Back" title="Back" onClick={() => navigate(slug ? ROOT : HOME)} className="p-1.5">
        <ChevronLeft size={20} color="#fff" />
      </button>
      <button aria-label="Media home" title="Media home" onClick={() => navigate(HOME)} className="p-1.5">
        <Home size={17} color="#fff" />
      </button>
      <h1 className="text-sm md:text-base font-bold text-white min-w-0 truncate">
        <button onClick={() => navigate(HOME)} style={{ color: MUTED }}>
          Media
        </button>
        <span style={{ color: MUTED }}> › </span>
        <button onClick={() => navigate(ROOT)} style={{ color: title ? MUTED : '#fff' }}>
          Artists
        </button>
        {title && <span> › {title}</span>}
      </h1>
    </div>
  );
};

const Index = () => {
  const navigate = useNavigate();
  return (
    <div className="px-4 py-6 max-w-5xl mx-auto w-full">
      <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
        bMusic
      </div>
      <h2 className="text-3xl font-bold text-white mt-1 mb-6">Artists</h2>
      <div className="flex flex-wrap gap-6">
        {ARTISTS.map((albums) => {
          const a = albums[0];
          return (
            <button
              key={a.artistSlug}
              onClick={() => navigate(`${ROOT}/${a.artistSlug}`)}
              className="text-left"
              style={{ width: 220 }}
            >
              <img
                src={coverOf(a)}
                alt=""
                className="w-[220px] aspect-square object-cover rounded-xl"
                style={{ boxShadow: `0 0 0 1px ${GOLD}80` }}
              />
              <div className="mt-2 font-bold text-white">{a.artist}</div>
              <div className="text-[13px]" style={{ color: MUTED }}>
                {albums.length} release{albums.length === 1 ? '' : 's'}
                {a.video ? ' · 1 video' : ''}
              </div>
              <span className="text-sm font-bold" style={{ color: GOLD }}>
                Listen
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const Artist = ({ albums }: { albums: ShareAlbum[] }) => {
  const navigate = useNavigate();
  const a = albums[0];
  const [board, setBoard] = useState<Board | null>(null);
  const [pot, setPot] = useState<Pot | null>(null);
  useEffect(() => {
    void getJson<Board>(`/api/bmusic/leaderboard?albumId=${encodeURIComponent(a.id)}`).then(setBoard);
    void getJson<Pot>(`/api/bmusic/stream/sponsored?albumId=${encodeURIComponent(a.id)}`).then(setPot);
  }, [a.id]);
  const listeners = board?.listeners ?? [];
  const potPct = pot?.capSats ? Math.max(0, Math.min(100, (100 * (pot.potSats ?? 0)) / pot.capSats)) : 0;
  return (
    <div className="px-4 py-6 max-w-5xl mx-auto w-full flex flex-wrap gap-10">
      <img
        src={coverOf(a)}
        alt={a.artist}
        className="w-full max-w-[360px] aspect-square object-cover rounded-xl self-start"
        style={{ boxShadow: `0 0 0 1px ${GOLD}80, 0 0 60px ${GOLD}26` }}
      />
      <div className="flex-1 min-w-[260px] text-white">
        <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
          Artist
        </div>
        <h2 className="text-4xl font-bold mt-2 mb-1">{a.artist}</h2>
        {a.artistBio && <div className="text-lg text-[#ddd]">{a.artistBio}</div>}
        <div className="mt-4 font-semibold" style={{ color: GOLD }}>
          {a.pricing}
        </div>
        {pot?.capSats ? (
          <div className="my-3">
            <div className="text-[13px] mb-1.5" style={{ color: MUTED }}>
              Sponsor pot: {bsv(pot.potSats ?? 0)}
              {pot.sponsored ? ' · paying for tracks 1–6' : ' · empty'}
            </div>
            <div className="h-2 rounded" style={{ background: '#222' }}>
              <div className="h-2 rounded" style={{ width: `${potPct}%`, background: GOLD }} />
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-4 mt-3">
          <button
            onClick={() => navigate(`${HOME}/album/${encodeURIComponent(a.id)}`)}
            className="px-6 py-2.5 rounded-full font-bold text-black"
            style={{ background: GOLD }}
          >
            Listen
          </button>
          {a.artistSite && (
            <a href={a.artistSite} target="_blank" rel="noopener noreferrer" style={{ color: GOLD }}>
              {a.artistSite.replace(/^https:\/\//, '')}
            </a>
          )}
        </div>
        {albums.map((al) => (
          <div key={al.id}>
            <h3 className="mt-7 text-xl font-bold">
              <button onClick={() => navigate(`${HOME}/album/${encodeURIComponent(al.id)}`)}>{al.title}</button>
            </h3>
            <ol className="mt-2 border-t" style={{ borderColor: '#222' }}>
              {al.tracks.map((t, i) => (
                <li key={i} className="flex gap-3 py-2 px-0.5 border-b text-sm" style={{ borderColor: '#222' }}>
                  <span className="w-6 text-right" style={{ color: '#777' }}>
                    {i + 1}
                  </span>
                  <span className="flex-1">
                    {t.title}
                    <Price id={trackId(al, i)} site={al.artistSite} />
                  </span>
                  <span style={{ color: '#777' }}>{mmss(t.seconds)}</span>
                  <span
                    className="w-24 text-right text-[11px] font-bold uppercase"
                    style={{ color: t.sponsored ? GOLD : '#777' }}
                  >
                    {t.sponsored ? `On ${al.sponsoredBy ?? al.artist}` : '1 sat/sec'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
        {a.video && (
          <>
            <h3 className="mt-7 mb-1.5 text-xl font-bold">Video: {a.video.title}</h3>
            <div className="text-[13px]" style={{ color: MUTED }}>
              Streams in bWalletX at 1 sat/sec. <Price id={a.video.releaseId} site={a.artistSite} />
            </div>
          </>
        )}
        <h3 className="mt-7 text-xl font-bold">Top listeners</h3>
        <ol className="mt-2 border-t" style={{ borderColor: '#222' }}>
          {board &&
            (listeners.length ? (
              listeners.slice(0, 10).map((x, i) => (
                <li key={i} className="flex gap-3 py-2 border-b text-sm" style={{ borderColor: '#222' }}>
                  <span className="w-6 text-right" style={{ color: '#777' }}>
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate">
                    {String(x.handle || x.name || x.paymail || x.identityKey || 'listener').slice(0, 32)}
                  </span>
                  <span style={{ color: '#777' }}>
                    {x.secondsTotal ? `${Math.round(x.secondsTotal / 60)} min` : ''}
                  </span>
                </li>
              ))
            ) : (
              <li className="py-2 border-b text-sm" style={{ borderColor: '#222' }}>
                Be the first listener{board.anonCount ? ` (${board.anonCount} anonymous so far)` : ''}
              </li>
            ))}
        </ol>
      </div>
    </div>
  );
};

const ArtistsPage = () => {
  const { slug } = useParams();
  const albums = slug ? ARTISTS.find((x) => x[0].artistSlug === slug) : undefined;
  return (
    <div className="w-full h-full flex flex-col overflow-y-auto pb-44" style={{ background: '#010101' }}>
      <TopNav />
      <div className="h-14 shrink-0" aria-hidden />
      <Bar title={albums?.[0].artist} slug={!!slug} />
      {albums ? <Artist albums={albums} /> : <Index />}
    </div>
  );
};

export default ArtistsPage;
