import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { historyCacheKey, readHistoryCache, writeHistoryCache } from './historyCache';
import { loadHistoryRows } from './historyLoad';
import { usePodcasts } from '../bradio/usePodcasts';
import { isOwned } from '../bradio/podcasts';
import { fetchPublicEpisodes } from '../bradio/rssPodcasts';
import { closesAddressBook } from './addressBookGesture';
import {
  dayKey,
  episodeItems,
  groupByDay,
  monthGrid,
  podcastItems,
  tradeItems,
  type CalItem,
  type CalKind,
} from './bcalDays';
import './bcal.css';

/**
 * bCal (owner, 15 Oct 2026): the All cards browser's other sideways swipe. A month grid of the wallet's real
 * activity: items bought and sold (History rows), the podcast line-up (bRadio RSS episodes and recorded Spaces)
 * and the podcasts this wallet holds. Tap a day to list it. A source that cannot be read is hidden, never faked.
 * Swipe sideways, × or Escape closes it.
 */
const KIND_LABEL: Record<CalKind, string> = {
  buy: 'Bought',
  sell: 'Sold',
  episode: 'Podcast line-up',
  podcast: 'bRadio podcast',
  held: 'Podcast you hold',
};
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The account's buy / sell rows: the History screen's cached copy at once, then a quiet refresh. Null = unreadable. */
const useTrades = (): CalItem[] | null => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const addrs = chromeStorageService.getCurrentAccountObject().account?.addresses;
  const addresses = useMemo(
    () => [...new Set([addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress].filter((a): a is string => !!a))],
    [addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress],
  );
  const key = historyCacheKey(addresses);
  const [items, setItems] = useState<CalItem[] | null>(() => {
    const hit = readHistoryCache(key);
    return hit ? tradeItems(hit.rows) : null;
  });
  useEffect(() => {
    if (!addresses.length || !apiContext) return;
    let live = true;
    const now = Date.now();
    loadHistoryRows({
      addresses,
      identityAddress: addrs?.identityAddress,
      apiContext,
      onProgress: () => undefined,
      now,
    })
      .then((rows) => {
        writeHistoryCache(key, { rows, at: now });
        if (live) setItems(tradeItems(rows));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [addresses, addrs?.identityAddress, apiContext, key]);
  return items;
};

const useEpisodes = (): CalItem[] | null => {
  const [items, setItems] = useState<CalItem[] | null>(null);
  useEffect(() => {
    let live = true;
    fetchPublicEpisodes()
      .then((eps) => live && setItems(eps.length ? episodeItems(eps) : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return items;
};

export const BCal = ({ onClose }: { onClose: () => void }) => {
  const trades = useTrades();
  const episodes = useEpisodes();
  const { items: pods, owned } = usePodcasts();
  const podcasts = useMemo(
    () => (pods && pods.length ? podcastItems(pods, (p) => isOwned(p, owned)) : null),
    [pods, owned],
  );
  const today = new Date();
  const [ym, setYm] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [picked, setPicked] = useState(dayKey(today.getTime()));
  const byDay = useMemo(
    () => groupByDay([...(trades ?? []), ...(episodes ?? []), ...(podcasts ?? [])]),
    [trades, episodes, podcasts],
  );
  const cells = useMemo(() => monthGrid(ym.y, ym.m), [ym]);
  const dayItems = byDay.get(picked) ?? [];
  const shift = (n: number) =>
    setYm(({ y, m }) => ({ y: m + n < 0 ? y - 1 : m + n > 11 ? y + 1 : y, m: (m + n + 12) % 12 }));
  // Which sources are real and readable right now; the rest have no legend entry and no dots.
  const legend: CalKind[] = [
    ...(trades ? (['buy', 'sell'] as CalKind[]) : []),
    ...(episodes ? (['episode'] as CalKind[]) : []),
    ...(podcasts ? (['podcast', 'held'] as CalKind[]) : []),
  ];

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const [t0, setT0] = useState<{ x: number; y: number } | null>(null);

  return createPortal(
    <div
      className="bw-bcal"
      role="dialog"
      aria-modal="true"
      aria-label="bCal"
      onTouchStart={(e) => setT0({ x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        if (!t0) return;
        const t = e.changedTouches[0];
        const d = { dx: t.clientX - t0.x, dy: t.clientY - t0.y };
        setT0(null);
        // Came in from the right: a swipe back the other way (finger moving right) closes it.
        if (closesAddressBook({ dx: -d.dx, dy: d.dy })) onClose();
      }}
    >
      <div className="bw-bcal-head">
        <b>bCal</b>
        <button type="button" aria-label="Close bCal" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="bw-bcal-month">
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <span>
          {MONTHS[ym.m]} {ym.y}
        </span>
        <button type="button" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="bw-bcal-grid" role="grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="bw-bcal-dow" aria-hidden="true">
            {d}
          </span>
        ))}
        {cells.map((c) => {
          const items = byDay.get(c.key) ?? [];
          const kinds = [...new Set(items.map((x) => x.kind))];
          return (
            <button
              type="button"
              key={c.key}
              className={`bw-bcal-day${c.inMonth ? '' : ' is-out'}${c.key === picked ? ' is-on' : ''}${items.length ? ' has-items' : ''}`}
              aria-label={`${c.key}: ${items.length} item${items.length === 1 ? '' : 's'}`}
              onClick={() => setPicked(c.key)}
            >
              <span>{c.day}</span>
              <span className="bw-bcal-dots" aria-hidden="true">
                {kinds.slice(0, 3).map((k) => (
                  <i key={k} className={`is-${k}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {legend.length > 0 && (
        <div className="bw-bcal-legend">
          {legend.map((k) => (
            <span key={k}>
              <i className={`is-${k}`} /> {KIND_LABEL[k]}
            </span>
          ))}
        </div>
      )}
      <div className="bw-bcal-list">
        <h3>
          {new Date(`${picked}T12:00:00`).toLocaleDateString(undefined, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </h3>
        {dayItems.length === 0 ? (
          <p className="bw-bcal-empty">Nothing on this day.</p>
        ) : (
          dayItems.map((it) => (
            <div key={it.id} className="bw-bcal-item">
              <i className={`is-${it.kind}`} aria-hidden="true" />
              <span>
                <b>{it.title}</b>
                <small>
                  {KIND_LABEL[it.kind]} · {it.sub} ·{' '}
                  {new Date(it.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </small>
              </span>
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
};
