import { useState } from 'react';
import { HEADLINE_ALBUM } from '../featured/featured';
import { VEXVOID_THUMBS } from '../featured/stills';
import { SponsorBadge } from './SponsorBadge';
import { isSponsoredTrack } from './keySource';
import { sponsorName, useManifest, useSponsor } from './useAlbum';

const GOLD = 'var(--bw-accent-hi)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * The album's tracks as compact rows, for the Media page (bWalletX only, lazy under PAY_STREAM_ENABLED):
 * `compact` = the first rows inside the featured banner; "See all" expands them in place; otherwise the full list with thumbs.
 * Tap the headline = play it free; tap another = open the album page on that track (index in the manifest).
 */
export default function FeaturedTracks(p: {
  compact?: boolean;
  headlinePlaying: boolean;
  headlineDuration?: number;
  onHeadline: () => void;
  onTrack: (index: number) => void;
  onAll: () => void;
}) {
  const { m, error, view } = useManifest();
  const [sponsor] = useSponsor();
  const rows = view ? view.paid : [];
  const total = rows.length + 1;
  const [all, setAll] = useState(false);
  const shown = p.compact && !all ? rows.slice(0, 5) : rows;
  const thumb = (n: number) => VEXVOID_THUMBS[n % VEXVOID_THUMBS.length];
  const tag = (t: string, gold: boolean) => (
    <span
      className="px-1.5 py-0.5 text-[9px] font-bold uppercase shrink-0"
      style={{ border: `1px solid ${gold ? GOLD : LINE}`, color: gold ? GOLD : MUTED, borderRadius: 3 }}
    >
      {t}
    </span>
  );
  const row = (
    key: string,
    n: number,
    title: string,
    dur: string,
    label: string,
    gold: boolean,
    on: () => void,
    active = false,
  ) => (
    <button
      key={key}
      onClick={on}
      className="flex items-center gap-2.5 py-1.5 text-left w-full"
      style={{ borderBottom: `1px solid ${LINE}` }}
    >
      <span className="w-5 text-[11px] text-right shrink-0" style={{ color: active ? GOLD : MUTED }}>
        {active ? '▶' : n}
      </span>
      {!p.compact && (
        <img src={thumb(n - 1)} alt="" className="w-8 h-8 object-cover shrink-0" style={{ borderRadius: 3 }} />
      )}
      <span className="flex-1 min-w-0 text-[13px] text-white truncate">{title}</span>
      <span className="text-[11px] shrink-0" style={{ color: MUTED }}>
        {dur}
      </span>
      {tag(label, gold)}
    </button>
  );
  return (
    <div className="flex flex-col min-w-0">
      {!p.compact && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
          <h3 className="text-lg font-black text-white">Tracks</h3>
          <SponsorBadge s={sponsor} />
        </div>
      )}
      <div className="flex flex-col" style={{ borderTop: `1px solid ${LINE}` }}>
        {row(
          'headline',
          1,
          HEADLINE_ALBUM.headline.title,
          p.headlineDuration ? fmt(p.headlineDuration) : '',
          'Free',
          true,
          p.onHeadline,
          p.headlinePlaying,
        )}
        {m &&
          shown.map(({ index, track }, i) =>
            row(
              track.trackId,
              i + 2,
              track.title,
              fmt(track.segments * m.segmentSeconds),
              isSponsoredTrack(sponsor, track.trackId) ? `Sponsored by ${sponsorName(sponsor!)}` : '1 sat/sec',
              isSponsoredTrack(sponsor, track.trackId),
              () => p.onTrack(index),
            ),
          )}
        {!m && (
          <div className="py-1.5 text-[11px]" style={{ color: MUTED }}>
            {error ? 'The other tracks are unavailable right now.' : 'Loading the tracks…'}
          </div>
        )}
      </div>
      {p.compact && (
        <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
          {rows.length > shown.length || all ? (
            <button
              onClick={() => setAll((x) => !x)}
              className="text-xs font-bold underline-offset-4 hover:underline"
              style={{ color: GOLD }}
            >
              {all ? 'Show fewer' : `See all ${m ? total : ''} tracks`}
            </button>
          ) : (
            <button
              onClick={p.onAll}
              className="text-xs font-bold underline-offset-4 hover:underline"
              style={{ color: GOLD }}
            >
              View album
            </button>
          )}
          <SponsorBadge s={sponsor} />
        </div>
      )}
    </div>
  );
}
