import type { SponsorStatus } from './api';
import { sponsorName } from './useAlbum';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';

/** spentSats / capSats as a small gold bar. */
export const PotGauge = ({ s, wide }: { s: SponsorStatus; wide?: boolean }) => {
  const pct = s.capSats > 0 ? Math.min(100, (s.spentSats / s.capSats) * 100) : 100;
  return (
    <span className="inline-flex items-center gap-2 text-[10px]" style={{ color: MUTED }}>
      <span
        className={`inline-block h-1.5 ${wide ? 'w-32' : 'w-16'} overflow-hidden`}
        style={{ background: '#2b2f36', borderRadius: 3 }}
        role="meter"
        aria-label="Sponsor pot used"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="block h-full" style={{ width: `${pct}%`, background: GOLD }} />
      </span>
      {pct.toFixed(pct < 10 ? 1 : 0)}% of the pot used
      {typeof s.potSats === 'number' ? ` · ${s.potSats.toLocaleString()} sats left` : ''}
    </span>
  );
};

/** "Sponsored by VexVoid — free to listen" with the pot gauge; nothing when not sponsored. */
export const SponsorBadge = ({ s }: { s: SponsorStatus | null }) =>
  s?.sponsored ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm font-bold" style={{ color: GOLD }}>
        {s.payToPlayTracks?.length && s.sponsoredTracks?.length
          ? `First ${s.sponsoredTracks.length} tracks free: sponsored by ${sponsorName(s)}`
          : `Sponsored by ${sponsorName(s)} — free to listen`}
      </span>
      <PotGauge s={s} />
    </div>
  ) : null;
