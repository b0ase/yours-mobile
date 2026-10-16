/**
 * Feed › bNews › Video: news video cards from BNEWS_SOURCES (GMEHL today), above the headlines.
 * bWalletX only (BMOVIES_FEED_ENABLED, lazy chunk). Same rules as the reel: posters at once, one
 * player at a time (tap a card to play it; any other stops), creator credit only when the original
 * post is theirs, clips screened by screen.ts in parseFeed. Hidden when no source answers.
 */
import { useCallback, useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { openDappBrowser } from '../../dappBrowser';
import { appendPage, clipPageUrl, creditedHandle, findPoster, firstFrameUrl, type Clip } from './bmovies';
import { BNEWS_SOURCES, fetchMerged, type Cursors } from './videoSources';
import { phonePoster, useAppVisible, useNearView, useReelVideo } from '../reelMemory';
import { useInPeek } from '../../phone/pageEl';

const GREEN = '#30A46C';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const when = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const Card = ({
  c,
  playing: picked,
  onPlay,
  onStop,
}: {
  c: Clip;
  playing: boolean;
  onPlay: () => void;
  onStop: () => void;
}) => {
  const [poster, setPoster] = useState<string | null>(c.poster);
  const handle = creditedHandle(c);
  // Media only near the screen; the player stops when scrolled far away, the page is hidden or the app is.
  const [box, near] = useNearView<HTMLDivElement>();
  const offScreen = useInPeek();
  const appVisible = useAppVisible();
  const shown = near && !offScreen && appVisible;
  const playing = picked && shown;
  const video = useReelVideo(playing);
  useEffect(() => {
    if (picked && !shown) onStop();
  }, [picked, shown, onStop]);

  useEffect(() => {
    if (poster || !near) return;
    let live = true;
    void findPoster(c).then((p) => live && p && setPoster(p));
    return () => {
      live = false;
    };
  }, [c, poster, near]);

  return (
    <div
      ref={box}
      className="mx-4 mb-3 overflow-hidden rounded-2xl"
      style={{ background: '#0d0d0f', border: `1px solid ${LINE}` }}
    >
      <div className="relative w-full" style={{ aspectRatio: '16 / 9', background: '#010101' }}>
        {playing ? (
          <video
            ref={video}
            src={c.src}
            poster={poster ? phonePoster(poster) : undefined}
            autoPlay
            controls
            playsInline
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : (
          <button onClick={onPlay} aria-label={`Play ${c.title}`} className="absolute inset-0 h-full w-full">
            {!shown ? null : poster ? (
              <img
                src={phonePoster(poster)}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <video
                src={firstFrameUrl(c.src)}
                preload="metadata"
                muted
                playsInline
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            <span
              className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full"
              style={{ background: 'rgba(0,0,0,0.55)', border: `1px solid ${GREEN}` }}
            >
              <Play size={20} color="#fff" fill="#fff" />
            </span>
          </button>
        )}
      </div>
      <button onClick={() => void openDappBrowser(clipPageUrl(c))} className="block w-full p-3 text-left">
        <p className="text-sm font-semibold text-white line-clamp-2">{c.title}</p>
        <p className="mt-1 text-[11px]" style={{ color: MUTED }}>
          {handle && <span style={{ color: GREEN }}>@{handle} · </span>}
          via {c.via ?? 'bMovies'} · {when(c.at)}
        </p>
      </button>
    </div>
  );
};

const NewsVideos = () => {
  const [clips, setClips] = useState<Clip[]>([]);
  const [next, setNext] = useState<Cursors | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = useCallback(() => setPlaying(null), []);

  const load = useCallback(async (cursors: Cursors | null) => {
    setBusy(true);
    try {
      const page = await fetchMerged(BNEWS_SOURCES, cursors ?? {});
      setClips((have) => (cursors ? appendPage(have, page.clips) : page.clips));
      setNext(page.more ? page.cursors : null);
    } catch {
      // no source answering: the section stays hidden
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  if (!clips.length) return null;
  return (
    <section className="pb-2 pt-3">
      <p className="mx-4 mb-2 text-xs font-bold uppercase tracking-wider" style={{ color: GREEN }}>
        Video
      </p>
      {clips.map((c) => (
        <Card key={c.id} c={c} playing={playing === c.id} onPlay={() => setPlaying(c.id)} onStop={stop} />
      ))}
      {next && (
        <button
          onClick={() => void load(next)}
          disabled={busy}
          className="mx-auto block rounded-full px-4 py-2 text-xs font-semibold"
          style={{ color: GREEN, border: `1px solid ${GREEN}` }}
        >
          {busy ? 'Loading…' : 'More video'}
        </button>
      )}
    </section>
  );
};

export default NewsVideos;
