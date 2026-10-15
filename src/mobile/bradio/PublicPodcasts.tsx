import { useEffect, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { getState, playQueue, subscribe, toggle } from '../media/player';
import { fetchPublicEpisodes, formatDuration, type PodcastEpisode } from './rssPodcasts';

const MUTED = '#98A2B3';
const ORANGE = '#F76B15';

const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

/** Feed › bRadio: recent episodes from public podcast feeds. Hidden while loading, empty or failed. */
export const PublicPodcasts = ({ onExpand }: { onExpand?: () => void }) => {
  const [items, setItems] = useState<PodcastEpisode[]>([]);
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  useEffect(() => {
    let live = true;
    void fetchPublicEpisodes()
      .then((e) => live && setItems(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!items.length) return null;

  const play = (i: number) => {
    const id = `rss:${items[i].id}`;
    if (s.queue[s.index]?.id === id) return toggle();
    playQueue(
      items.map((e) => ({
        id: `rss:${e.id}`,
        title: e.title,
        url: e.audio,
        artwork: e.image ?? undefined,
        subtitle: e.showName,
        album: 'bRadio · Podcasts',
        onExpand,
      })),
      i,
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-white m-0">Podcasts</h2>
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          Free · from public feeds
        </p>
      </div>
      {items.map((e, i) => {
        const on = s.queue[s.index]?.id === `rss:${e.id}` && s.playing;
        return (
          <div key={e.id} className="flex gap-3 rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36] p-3">
            <button
              type="button"
              onClick={() => play(i)}
              aria-label={on ? `Pause ${e.title}` : `Play ${e.title}`}
              className="relative w-16 h-16 rounded-xl shrink-0 overflow-hidden border-0 p-0 cursor-pointer"
              style={{ background: '#2a1708' }}
            >
              {e.image ? (
                <img src={e.image} alt="" loading="lazy" className="w-full h-full object-cover" />
              ) : (
                <Mic size={22} color={ORANGE} />
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                {on ? <Pause size={20} color="#fff" /> : <Play size={20} color="#fff" />}
              </span>
            </button>
            <div className="flex-1 min-w-0 flex flex-col gap-1">
              <div className="text-sm font-bold text-white line-clamp-2">{e.title}</div>
              <div className="text-xs truncate" style={{ color: MUTED }}>
                {[e.showName, fmtDate(e.at), formatDuration(e.duration)].filter(Boolean).join(' · ')}
              </div>
              <a
                href={e.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] no-underline truncate"
                style={{ color: 'var(--bw-accent)' }}
              >
                From {e.showName}
              </a>
            </div>
          </div>
        );
      })}
    </section>
  );
};
