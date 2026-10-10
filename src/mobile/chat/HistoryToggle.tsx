/**
 * Room admin toggle: "New members can see earlier messages" (on by default). The server
 * (bit-sign rooms/[ticker]/history) refuses anyone but the room's admin; this only renders
 * for the admin and shows the server's answer if it says no.
 */
import { useEffect, useState } from 'react';
import type { BchatClient } from './api';
import { HISTORY_OFF_NOTE, HISTORY_ON_NOTE, HISTORY_TOGGLE_LABEL, type HistoryVisibility } from './history';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#FFD24D';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const RED = '#F97066';

export const HistoryToggle = ({ client, ticker }: { client: BchatClient; ticker: string }) => {
  const [visibility, setVisibility] = useState<HistoryVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    client
      .historySetting(ticker)
      .then((s) => live && setVisibility(s.visibility))
      .catch(() => live && setVisibility('all'));
    return () => {
      live = false;
    };
  }, [client, ticker]);

  const on = visibility !== 'since_join';
  const flip = async () => {
    if (visibility === null || busy) return;
    const next: HistoryVisibility = on ? 'since_join' : 'all';
    setBusy(true);
    setError('');
    try {
      await client.setHistoryVisibility(ticker, next);
      setVisibility(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-white">{HISTORY_TOGGLE_LABEL}</span>
        <button
          role="switch"
          aria-checked={on}
          aria-label={HISTORY_TOGGLE_LABEL}
          onClick={() => void flip()}
          disabled={visibility === null || busy}
          className="relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50"
          style={{ background: on ? GOLD : '#2a2d33' }}
        >
          <span
            className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
            style={{ left: on ? 22 : 2 }}
          />
        </button>
      </div>
      <p className="text-xs mt-1" style={{ color: MUTED }}>
        {on ? HISTORY_ON_NOTE : HISTORY_OFF_NOTE}
      </p>
      {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs mt-1" style={{ color: RED }}>
          {error}
        </p><ErrorActions message={String(error)} /></div>
)}
    </div>
  );
};
