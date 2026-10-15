import { useEffect, useState } from 'react';
import { Mic, Pause, Play } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getState, subscribe, toggle } from '../media/player';
import { fmtDuration, type Podcast } from './podcasts';
import { playPodcast } from './usePodcasts';

const MUTED = '#98A2B3';
const ORANGE = '#F76B15';

export const PodcastCard = ({
  p,
  owned,
  price,
  onBuy,
  onExpand,
}: {
  p: Podcast;
  owned: boolean;
  /** Formatted price, shown with Buy. */
  price?: string;
  /** Present only where buying is allowed (never in a store build). */
  onBuy?: () => void;
  onExpand?: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  const current = s.queue[s.index]?.id === `podcast:${p.id}`;
  const mine = owned;

  const play = async () => {
    if (current) return toggle();
    setBusy(true);
    setNote('');
    const r = await playPodcast(p, mine, apiContext, onExpand);
    setBusy(false);
    if (r === 'listed') setNote('Listed for sale — cancel the listing to play in full');
    else if (r === 'none') setNote('Preview not available yet.');
    else if (r === 'preview' && mine) setNote('Full recording isn’t available yet, so this is the preview.');
  };

  return (
    <div className="flex gap-3 rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36] p-3">
      {p.cover ? (
        <img src={p.cover} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" />
      ) : (
        <div
          className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center"
          style={{ background: '#2a1708' }}
        >
          <Mic size={22} color={ORANGE} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="text-sm font-bold text-white truncate">{p.title}</div>
        <div className="text-xs truncate" style={{ color: MUTED }}>
          {[p.host && `@${p.host}`, fmtDuration(p.duration), mine && 'Yours'].filter(Boolean).join(' · ')}
        </div>
        {!p.previewUrl && !mine && (
          <div className="text-[11px]" style={{ color: MUTED }}>
            Preview not available yet
          </div>
        )}
        {note && (
          <div className="text-[11px]" role="status" style={{ color: MUTED }}>
            {note}
          </div>
        )}
        <div className="flex gap-2 items-center mt-1">
          {(p.previewUrl || mine) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void play()}
              className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer disabled:opacity-50"
              style={{ background: ORANGE, color: '#000' }}
            >
              {current && s.playing ? <Pause size={14} /> : <Play size={14} />}
              {busy ? 'Loading…' : current && s.playing ? 'Pause' : mine ? 'Play' : 'Preview'}
            </button>
          )}
          {onBuy && !mine && (
            <button
              type="button"
              onClick={onBuy}
              className="rounded-lg px-3 py-1.5 text-xs font-bold border cursor-pointer bg-transparent"
              style={{ borderColor: 'var(--bw-accent)', color: 'var(--bw-accent)' }}
            >
              {price ? `Buy ${price}` : 'Buy'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
