import { useEffect, useState } from 'react';
import { ChevronDown, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { getState, next, previous, seek, subscribe, toggle } from '../player';
import { albumStyle } from './albumTheme';
import type { Palette } from './library';

const fmt = (s: number) =>
  isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';

/**
 * iPod-style Now Playing for the private library: a square cover the full width of the screen (capped on wide
 * screens), then the track title, a scrub bar and prev / play / next. Phone first; nothing scrolls sideways.
 * The album's colours are scoped to this overlay only (albumStyle); the wallet underneath keeps the user's theme.
 */
export const NowPlaying = ({ onClose, theme }: { onClose: () => void; theme?: Palette }) => {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  const track = s.queue[s.index];
  if (!track) return null;
  const btn = 'p-3 rounded-full active:opacity-70';
  return (
    <div
      role="dialog"
      aria-label="Now playing"
      className="fixed inset-0 z-[120] flex flex-col overflow-y-auto overflow-x-hidden"
      style={theme ? albumStyle(theme) : { background: 'var(--bw-bg)', color: 'var(--bw-text)' }}
    >
      <div className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <button aria-label="Close" title="Close" onClick={onClose} className="p-2 -ml-2">
          <ChevronDown size={26} />
        </button>
        <span className="text-xs uppercase tracking-wider truncate min-w-0" style={{ color: 'var(--bw-muted)' }}>
          {track.album}
        </span>
        <span className="w-10" aria-hidden />
      </div>
      <div className="w-full max-w-[560px] mx-auto flex flex-col">
        {track.artwork ? (
          <img
            src={track.artwork}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full aspect-square object-cover block"
          />
        ) : (
          <div className="w-full aspect-square" style={{ background: 'var(--bw-surface)' }} />
        )}
        <div className="px-5 pt-5 pb-8 flex flex-col gap-4">
          <div className="min-w-0">
            <div className="text-xl font-semibold break-words">{track.title}</div>
            {track.subtitle && (
              <div className="text-sm break-words" style={{ color: 'var(--bw-muted)' }}>
                {track.subtitle}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <input
              type="range"
              aria-label="Scrub"
              min={0}
              max={s.duration || 0}
              step={0.1}
              value={Math.min(s.time, s.duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              className="w-full"
              style={{ accentColor: 'var(--bw-accent)' }}
            />
            <div className="flex justify-between text-xs tabular-nums" style={{ color: 'var(--bw-muted)' }}>
              <span>{fmt(s.time)}</span>
              <span>-{fmt(Math.max(0, s.duration - s.time))}</span>
            </div>
          </div>
          <div className="flex items-center justify-center gap-8">
            <button aria-label="Previous" title="Previous" onClick={previous} className={btn}>
              <SkipBack size={30} fill="currentColor" />
            </button>
            <button
              aria-label={s.playing ? 'Pause' : 'Play'}
              title={s.playing ? 'Pause' : 'Play'}
              onClick={toggle}
              className="p-4 rounded-full active:opacity-70"
              style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent, #000)' }}
            >
              {s.playing ? <Pause size={34} fill="currentColor" /> : <Play size={34} fill="currentColor" />}
            </button>
            <button
              aria-label="Next"
              title="Next"
              onClick={next}
              disabled={s.index >= s.queue.length - 1}
              className={`${btn} disabled:opacity-30`}
            >
              <SkipForward size={30} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
