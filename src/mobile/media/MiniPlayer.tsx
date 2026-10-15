import { useEffect, useState } from 'react';
import { Music, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { getState, next, previous, seek, stop, subscribe, toggle } from './player';

const fmt = (s: number) =>
  isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

/** Now-playing bar above the tab bar; mounted app-wide (vite.config.mobile.ts) so it follows every tab. */
const MiniPlayer = () => {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  const track = s.queue[s.index];
  if (!track) return null;
  const btn = 'p-2 rounded-full active:bg-[#2b2f36]';
  return (
    <div
      className="absolute left-2 right-2 z-[101] rounded-xl bg-[var(--bw-surface)] border border-[#2b2f36] px-3 pt-2 pb-1"
      style={{ bottom: '4rem' }}
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
          <div className="text-xs font-semibold text-white truncate">{track.title}</div>
          <div className="text-[10px] text-[#98A2B3] truncate">
            {fmt(s.time)} / {fmt(s.duration)}
            {s.queue.length > 1 ? ` · ${s.index + 1} of ${s.queue.length}` : ''}
            {track.subtitle ? ` · ${track.subtitle}` : ''}
            {track.label ? ` · ${track.label}` : ''}
          </div>
        </button>
        <button aria-label="Previous" className={btn} onClick={previous}>
          <SkipBack size={16} color="#fff" />
        </button>
        <button aria-label={s.playing ? 'Pause' : 'Play'} className={btn} onClick={toggle}>
          {s.playing ? <Pause size={18} color="#fff" /> : <Play size={18} color="#fff" />}
        </button>
        <button aria-label="Next" className={btn} onClick={next}>
          <SkipForward size={16} color="#fff" />
        </button>
        <button aria-label="Close player" className={btn} onClick={stop}>
          <X size={16} color="#98A2B3" />
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
  );
};

export default MiniPlayer;
