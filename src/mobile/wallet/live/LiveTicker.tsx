import { lazy, Suspense, useEffect, useState, type MouseEvent } from 'react';
import { tickText } from './liveLogic';
import { useLive, visibleTicks } from './liveBus';

const HistoryScreen = lazy(() => import('../HistoryScreen'));

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Under the card's balance: the last few payments as they happen ("−27 sats · TokenBlaster", "+500 sats ·
 * received"), each fading after a few seconds, and a meter per live dApp session ("TokenBlaster session: 1,240
 * sats left"). Tap → History. Styles: .bw-live* in mobile.css. Hidden while the balance is hidden.
 */
export const LiveTicker = ({ hidden = false }: { hidden?: boolean }) => {
  const live = useLive();
  const [now, setNow] = useState(() => Date.now());
  const [historyOpen, setHistoryOpen] = useState(false);
  const ticks = visibleTicks(live, now);
  const sessions = Object.values(live.sessions);

  // Re-render while anything is on screen, so ticks fade out on time.
  useEffect(() => {
    if (!live.ticks.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(t);
  }, [live.ticks]);

  const history = historyOpen ? (
    <Suspense fallback={null}>
      <HistoryScreen onClose={() => setHistoryOpen(false)} />
    </Suspense>
  ) : null;
  if (hidden || (!ticks.length && !sessions.length)) return history;

  const open = (e: MouseEvent) => {
    e.stopPropagation();
    setHistoryOpen(true);
  };

  return (
    <>
      <div className="bw-live" aria-live="polite">
        {sessions.map((s) => (
          <button
            key={`${s.origin}|${s.session}`}
            type="button"
            className="bw-live-session"
            onClick={open}
            title={`${fmt(s.spent)} of ${fmt(s.ceiling)} sats used`}
          >
            <span className="bw-live-dot" aria-hidden="true" />
            {s.label} session: <b>{fmt(s.left)}</b> sats left
            <span className="bw-live-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(2, Math.round((s.left / Math.max(1, s.ceiling)) * 100))}%` }} />
            </span>
          </button>
        ))}
        {ticks.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`bw-live-tick ${t.sats < 0 ? 'is-out' : 'is-in'}`}
            onClick={open}
            aria-label={`${tickText(t)}. Open history`}
          >
            {tickText(t)}
          </button>
        ))}
      </div>
      {history}
    </>
  );
};
