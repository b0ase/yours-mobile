import { useContext, useEffect, useRef, useState } from 'react';
import { GuestCtx } from './guestCtx';
import { LOAD_FAILED, playErrorMessage } from './playError';
import { ARTIST_PROGRAMME_ENABLED } from '../../storeBuild';
import { ProgrammeBlock } from './programme/ProgrammeBlock';
import { HEADLINE_ALBUM } from '../featured/featured';
import { resumeAt } from '../../url/resume';
import { logStep, setPending } from '../../onboarding/funnel/funnel';
import { BMUSIC_FUNNEL } from '../../onboarding/funnel/products';
import { GetWalletSheet } from '../../onboarding/funnel/FunnelSheets';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Home, Loader2, Pause, Play } from 'lucide-react';
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
const HOME_ROUTE = '/m/media';
const HOME = HOME_ROUTE;
const ROOT = '/m/media/artists';

/** "Get bWalletX / Unlock to listen" for a guest. */
export const GuestPrompt = ({ label = 'Unlock to listen' }: { label?: string }) => {
  const guest = useContext(GuestCtx);
  if (!guest) return null;
  return (
    <button onClick={guest} className="px-5 py-2.5 rounded-full font-bold text-black" style={{ background: GOLD }}>
      {label}
    </button>
  );
};

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

const Price = ({ id, site, onGuest }: { id: string; site?: string; onGuest?: () => void }) => {
  const guest = useContext(GuestCtx);
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
  if (guest)
    return (
      <button onClick={onGuest ?? guest} className="block text-[12px]" style={{ color: GOLD }}>
        Buy the original · {bsv(r.mintPriceSats)}
      </button>
    );
  return (
    <a href={site} target="_blank" rel="noopener noreferrer" className="text-[12px]" style={{ color: GOLD }}>
      Buy the original · {bsv(r.mintPriceSats)}
    </a>
  );
};

const Bar = ({ title, slug }: { title?: string; slug?: boolean }) => {
  const navigate = useNavigate();
  // A guest has no Media store (it needs the wallet): Home is the artists list.
  const HOME = useContext(GuestCtx) ? ROOT : HOME_ROUTE;
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
  const guest = useContext(GuestCtx);
  return (
    <div className="px-4 py-6 max-w-5xl mx-auto w-full">
      <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
        bMusic
      </div>
      <h2 className="text-3xl font-bold text-white mt-1 mb-6">Artists</h2>
      {ARTIST_PROGRAMME_ENABLED && !guest && (
        <button
          onClick={() => navigate(`${ROOT}/join`)}
          className="mb-6 px-5 py-2.5 rounded-full font-bold text-black"
          style={{ background: GOLD }}
        >
          Join as an artist
        </button>
      )}
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
        {ARTIST_PROGRAMME_ENABLED && <ProgrammeBlock slug={a.artistSlug} />}
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

/** Guest top bar: the wallet's TopNav needs an unlocked account, so a guest gets the logo and one way in. */
const GuestTop = () => {
  const guest = useContext(GuestCtx);
  return (
    <div
      className="fixed top-0 inset-x-0 z-20 h-14 flex items-center justify-between px-4"
      style={{ background: '#010101', borderBottom: `1px solid ${LINE}` }}
    >
      <span className="font-extrabold text-white tracking-tight">
        bWallet<span style={{ color: GOLD }}>X</span>
      </span>
      <button
        onClick={guest ?? undefined}
        className="px-4 py-1.5 rounded-full text-sm font-bold text-black"
        style={{ background: GOLD }}
      >
        Get bWalletX / Unlock
      </button>
    </div>
  );
};

/** Guest album page (/bmusic/artist/<artist>/album/<slug>): cover, tracks, prices; playing needs the wallet. */
export const GuestAlbum = () => {
  const navigate = useNavigate();
  const { albumId } = useParams();
  const al = SHARE_ALBUMS.find((x) => x.id === albumId);
  const guest = useContext(GuestCtx);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ask, setAsk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  if (!al) return <Index />;
  // The funnel (onboarding/funnel): track 1 is the album's free headline, a local asset, so it plays with no wallet
  // and no server. Anything after it asks for a wallet (sponsored tracks 2–6 need its key).
  const taste = al.tracks[0]?.title === HEADLINE_ALBUM.headline.title;
  const toggleTaste = () => {
    const a = (audio.current ??= new Audio(HEADLINE_ALBUM.headline.url));
    a.preload = 'auto';
    a.onended = () => {
      setPlaying(false);
      setAsk(true);
    };
    a.onerror = () => {
      setLoading(false);
      setPlaying(false);
      setError(LOAD_FAILED);
    };
    if (a.paused) {
      logStep(BMUSIC_FUNNEL.id, 'taste');
      setError(null);
      setLoading(true);
      // After a load error the element stays errored; reload so "Try again" actually retries.
      if (a.error) a.load();
      void a.play().then(
        () => {
          setLoading(false);
          setPlaying(true);
        },
        (err: unknown) => {
          setLoading(false);
          setPlaying(false);
          setError((e) => e ?? playErrorMessage(err));
        },
      );
    } else {
      a.pause();
      setPlaying(false);
    }
  };
  const more = () => {
    audio.current?.pause();
    setPlaying(false);
    setAsk(true);
  };
  const create = () => {
    audio.current?.pause();
    setPending(BMUSIC_FUNNEL.id, 'more');
    // Back to the in-app album page, where the sponsored tracks pick up at track 2.
    resumeAt(`${HOME_ROUTE}/album/${encodeURIComponent(HEADLINE_ALBUM.id)}`);
    guest?.();
  };
  return (
    <div className="px-4 py-6 max-w-5xl mx-auto w-full flex flex-wrap gap-10">
      <img
        src={coverOf(al)}
        alt={al.title}
        className="w-full max-w-[360px] aspect-square object-cover rounded-xl self-start"
        style={{ boxShadow: `0 0 0 1px ${GOLD}80, 0 0 60px ${GOLD}26` }}
      />
      <div className="flex-1 min-w-[260px] text-white">
        <div className="text-[12px] font-bold tracking-[.18em] uppercase" style={{ color: GOLD }}>
          Album
        </div>
        <h2 className="text-4xl font-bold mt-2 mb-1">{al.title}</h2>
        <button onClick={() => navigate(`${ROOT}/${al.artistSlug}`)} className="text-lg text-[#ddd]">
          {al.artist}
        </button>
        <div className="mt-3 font-semibold" style={{ color: GOLD }}>
          {al.pricing}
        </div>
        {taste ? (
          <>
            <p className="text-[13px] mt-2 mb-3" style={{ color: MUTED }}>
              Track 1 is free to hear right here.
            </p>
            <button
              onClick={toggleTaste}
              disabled={loading}
              aria-busy={loading}
              className="px-5 py-2.5 rounded-full font-bold text-black inline-flex items-center gap-2 disabled:opacity-80"
              style={{ background: GOLD }}
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : playing ? (
                <Pause size={16} />
              ) : (
                <Play size={16} fill="#000" />
              )}
              {loading ? 'Loading…' : playing ? 'Pause' : 'Play track 1 free'}
            </button>
            {error && (
              <p role="alert" className="text-[13px] mt-2" style={{ color: '#f87171' }}>
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] mt-2 mb-3" style={{ color: MUTED }}>
              Listening, even to the free sponsored tracks, runs through your own bWalletX: it holds the key each second
              of music is unlocked with. Make one free in a minute, or unlock yours, and you come straight back here.
            </p>
            <GuestPrompt />
          </>
        )}
        <ol className="mt-6 border-t" style={{ borderColor: '#222' }}>
          {al.tracks.map((t, i) => (
            <li
              key={i}
              className="flex items-center gap-3 py-2 px-0.5 border-b text-sm"
              style={{ borderColor: '#222' }}
            >
              <GuestPlay
                n={i + 1}
                free={taste && i === 0}
                playing={taste && i === 0 && playing}
                onClick={taste ? (i === 0 ? toggleTaste : more) : undefined}
              />
              <span className="flex-1">
                {t.title}
                <Price id={trackId(al, i)} site={al.artistSite} onGuest={taste ? more : undefined} />
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
      {ask && <GetWalletSheet product={BMUSIC_FUNNEL} onCreate={create} onClose={() => setAsk(false)} />}
    </div>
  );
};

const GuestPlay = ({
  n,
  free,
  playing,
  onClick,
}: {
  n: number;
  free?: boolean;
  playing?: boolean;
  onClick?: () => void;
}) => {
  const guest = useContext(GuestCtx);
  return (
    <button
      aria-label={free ? `Play track ${n} free` : `Play track ${n}: unlock to listen`}
      title={free ? 'Free' : 'Unlock to listen'}
      onClick={onClick ?? guest ?? undefined}
      className="w-6 flex justify-end"
    >
      {playing ? <Pause size={14} color={GOLD} /> : <Play size={14} color={GOLD} />}
    </button>
  );
};

const ArtistsPage = ({ album }: { album?: boolean }) => {
  const guest = useContext(GuestCtx);
  const { slug } = useParams();
  const albums = slug ? ARTISTS.find((x) => x[0].artistSlug === slug) : undefined;
  return (
    <div className="w-full h-full flex flex-col overflow-y-auto pb-44" style={{ background: '#010101' }}>
      {guest ? <GuestTop /> : <TopNav />}
      <div className="h-14 shrink-0" aria-hidden />
      <Bar title={album ? 'Album' : albums?.[0].artist} slug={!!slug || !!album} />
      {album ? <GuestAlbum /> : albums ? <Artist albums={albums} /> : <Index />}
    </div>
  );
};

export default ArtistsPage;
