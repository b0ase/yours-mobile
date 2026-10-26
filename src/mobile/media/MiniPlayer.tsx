import { useEffect, useRef, useState } from 'react';
import { Music, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { getState, next, previous, seek, stop, subscribe, toggle } from './player';
import { dockBottom, MINI_FALLBACK_BOTTOM } from './miniDock';
import { NowPlaying } from './library/NowPlaying';
import {
  closeLibrary,
  libraryNowPlaying,
  nowPlayingOpen,
  onNowPlayingOpen,
  setNowPlayingOpen,
} from './library/libraryPlayer';
import { albumOfTrackId } from './library/albumTheme';

const fmt = (s: number) =>
  isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

/** Now-playing bar above the tab bar; mounted app-wide (vite.config.mobile.ts) so it follows every tab. */
const MiniPlayer = () => {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  const [expanded, setExpanded] = useState(nowPlayingOpen);
  useEffect(() => onNowPlayingOpen(setExpanded), []);
  const track = s.queue[s.index];
  // Publishes the bar's height as --bw-mini-h, so what sits at the foot of a page (the Ask b composer) lifts
  // above it instead of hiding under it (owner, 15 Oct 2026).
  const box = useRef<HTMLDivElement>(null);
  const shown = !!track;
  // Docked directly above the bottom nav (Apple Music style), never over it: measured from the nav itself.
  const [bottom, setBottom] = useState<string>(MINI_FALLBACK_BOTTOM);
  useEffect(() => {
    const el = box.current;
    if (!shown || !el) return;
    const measure = () => {
      const parent = el.offsetParent as HTMLElement | null;
      const navs = [...document.querySelectorAll<HTMLElement>('[data-bw-bottom-nav]')].map((n) =>
        n.getBoundingClientRect(),
      );
      const px = dockBottom(parent?.getBoundingClientRect() ?? null, navs);
      setBottom(px === null ? MINI_FALLBACK_BOTTOM : `${px}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    document.querySelectorAll('[data-bw-bottom-nav]').forEach((n) => ro.observe(n));
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [shown]);
  useEffect(() => {
    const root = document.documentElement;
    const el = box.current;
    if (!shown || !el) {
      root.style.removeProperty('--bw-mini-h');
      return;
    }
    const set = () => root.style.setProperty('--bw-mini-h', `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--bw-mini-h');
    };
  }, [shown]);
  if (!track) return null;
  // Now Playing lives here, at the app shell, so it opens over whatever page you are on and never stops the music.
  const lib = albumOfTrackId(track.id) ? libraryNowPlaying() : null;
  const close = () => (lib ? closeLibrary() : stop());
  const btn = 'p-2 rounded-full active:bg-[var(--bw-line)]';
  return (
    <>
      {expanded && lib && <NowPlaying onClose={() => setNowPlayingOpen(false)} theme={lib.theme} cover={lib.cover} />}
      <div
        ref={box}
        className="absolute left-2 right-2 z-[101] rounded-xl bg-[var(--bw-surface)] border border-[var(--bw-line)] px-3 pt-2 pb-1"
        style={{ bottom }}
      >
        <div className="flex items-center gap-2">
          {track.artwork ? (
            <img src={track.artwork} alt="" className="w-8 h-8 rounded-md object-cover shrink-0" />
          ) : (
            <Music size={16} className="shrink-0" style={{ color: '#A1FF8B' }} />
          )}
          <button
            type="button"
            className="flex-1 min-w-0 text-left bg-transparent border-0 p-0"
            style={{ cursor: track.onExpand ? 'pointer' : 'default' }}
            onClick={track.onExpand}
            disabled={!track.onExpand}
            aria-label={track.onExpand ? `Open ${track.title}` : undefined}
          >
            <div className="text-xs font-semibold text-[var(--bw-text)] truncate">{track.title}</div>
            <div className="text-[10px] text-[var(--bw-muted)] truncate">
              {fmt(s.time)} / {fmt(s.duration)}
              {s.queue.length > 1 ? ` · ${s.index + 1} of ${s.queue.length}` : ''}
              {track.subtitle ? ` · ${track.subtitle}` : ''}
              {track.label ? ` · ${track.label}` : ''}
            </div>
          </button>
          <button aria-label="Previous" className={btn} onClick={previous}>
            <SkipBack size={16} color="var(--bw-text)" />
          </button>
          <button aria-label={s.playing ? 'Pause' : 'Play'} className={btn} onClick={toggle}>
            {s.playing ? <Pause size={18} color="var(--bw-text)" /> : <Play size={18} color="var(--bw-text)" />}
          </button>
          <button aria-label="Next" className={btn} onClick={next}>
            <SkipForward size={16} color="var(--bw-text)" />
          </button>
          <button aria-label="Close player" className={btn} onClick={close}>
            <X size={16} color="var(--bw-muted)" />
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={s.duration || 0}
          step={0.5}
          value={s.time}
          onChange={(e) => seek(Number(e.target.value))}
          className="w-full h-1 accent-[#A1FF8B]"
          aria-label="Seek"
          style={{ fontSize: 16 }}
        />
      </div>
    </>
  );
};

export default MiniPlayer;
