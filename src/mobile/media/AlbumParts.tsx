import type { ReactNode } from 'react';

/**
 * The album page's look, shared by the VexVoid album (stream/StreamAlbum.tsx) and the owner's private library
 * (library/OwnerLibrary.tsx): a big square cover beside an "Album" eyebrow, a heavy title, the artist line and the
 * play button, then numbered rows with a small cover, title, length and a badge. Presentation only; each page brings
 * its own playback. Colours come from the theme variables of whatever container it sits in.
 */

export function AlbumHeader(p: {
  cover: ReactNode;
  title: string;
  /** Artist · N tracks, plus anything the page adds (a tip button). */
  byline: ReactNode;
  /** White text for a header laid over pictures (the VexVoid stills); theme text otherwise. */
  onImage?: boolean;
  children?: ReactNode;
}) {
  const strong = p.onImage ? 'text-white' : '';
  return (
    <div className="flex flex-col md:flex-row gap-5 md:gap-8 p-4 md:p-6">
      <div className="w-full md:w-[260px] shrink-0">{p.cover}</div>
      <div className="flex-1 min-w-0 flex flex-col justify-end gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--bw-accent-hi)' }}>
          Album
        </div>
        <h2
          className={`text-3xl md:text-5xl font-black leading-tight break-words ${strong}`}
          style={p.onImage ? undefined : { color: 'var(--bw-text)' }}
        >
          {p.title}
        </h2>
        <div
          className={`text-sm flex items-center gap-2 flex-wrap ${p.onImage ? 'text-white/80' : ''}`}
          style={p.onImage ? undefined : { color: 'var(--bw-muted)' }}
        >
          {p.byline}
        </div>
        {p.children}
      </div>
    </div>
  );
}

/** The gold play / pause button under the album title. */
export function AlbumPlayButton(p: { playing: boolean; label: string; onClick: () => void; icon: ReactNode }) {
  return (
    <button
      onClick={p.onClick}
      className="px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
      style={{ background: 'var(--bw-accent-hi)', color: 'var(--bw-on-accent, #1a1300)', borderRadius: 4 }}
    >
      {p.icon}
      {p.label}
    </button>
  );
}

export function AlbumTrackRow(p: {
  n: number;
  active: boolean;
  playing: boolean;
  thumb?: string;
  title: string;
  /** Small gold line under the title (e.g. "Headline track"). */
  tag?: string;
  duration?: string;
  badge?: ReactNode;
  highlight?: boolean;
  /** Title colour class; the VexVoid page keeps white, the library uses the theme text. */
  textClass?: string;
  onClick: () => void;
}) {
  const gold = 'var(--bw-accent-hi)';
  return (
    <button
      onClick={p.onClick}
      aria-current={p.active ? 'true' : undefined}
      className="flex items-center gap-3 py-2 text-left min-w-0 w-full"
      style={{
        borderBottom: '1px solid var(--bw-line)',
        ...(p.highlight || p.active ? { background: 'rgb(var(--bw-accent-hi-rgb) / 0.06)' } : {}),
      }}
    >
      <span className="w-6 text-xs text-right shrink-0" style={{ color: p.active ? gold : 'var(--bw-muted)' }}>
        {p.active && p.playing ? '▶' : p.n}
      </span>
      {p.thumb ? (
        <img
          src={p.thumb}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="w-9 h-9 object-cover shrink-0"
          style={{ borderRadius: 3 }}
        />
      ) : null}
      <span className="flex-1 min-w-0">
        <span
          className={`block text-sm truncate ${p.textClass ?? ''}`}
          style={p.textClass ? (p.active ? { color: gold } : undefined) : { color: p.active ? gold : 'var(--bw-text)' }}
        >
          {p.title}
        </span>
        {p.tag && (
          <span className="block text-[10px] font-bold uppercase tracking-widest" style={{ color: gold }}>
            {p.tag}
          </span>
        )}
      </span>
      {p.duration ? (
        <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--bw-muted)' }}>
          {p.duration}
        </span>
      ) : null}
      {p.badge}
    </button>
  );
}
