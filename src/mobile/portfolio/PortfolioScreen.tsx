import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineChart, RefreshCw, TrendingDown, TrendingUp, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { formatUSD } from '../../utils/format';
import { loadHistoryRows } from '../wallet/historyLoad';
import type { HistoryRow } from '../wallet/txHistory';
import type { Progress } from '../wallet/txHistoryFetch';
import { loadPlans } from '../locks/lockApi';
import { fetchSeries } from './market';
import {
  isEstimated,
  profitUsd,
  rangeStart,
  rankHoldings,
  rebased,
  sampleTimes,
  twrSeries,
  valueSeries,
  type Holding,
  type PricePoint,
  type RangeId,
} from './portfolioMath';

/**
 * Portfolio vs market (owner, 10 Oct 2026): the price tile top-left opens this. How the account did over 1D–All
 * against simply holding BSV, holding BTC, or keeping dollars; what it holds; the BSV price today. Rebuilt from
 * the account's own history × the price on each day; anything estimated is said on screen. The BSV chart is one
 * tap away (`onBsvChart`).
 */
const BG = '#0d0e11';
const CARD = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const GOLD = '#FFD24D';
const BSV_C = '#F1EAD9';
const BTC_C = '#F7931A';
const UP = '#32D583';
const DOWN = '#F97066';
const RANGES: RangeId[] = ['1D', '1W', '1M', '1Y', 'ALL'];

const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%`;
const tone = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? MUTED : v >= 0 ? UP : DOWN;
const rangeWord = (r: RangeId) =>
  ({ '1D': 'today', '1W': 'this week', '1M': 'this month', '1Y': 'this year', ALL: 'since your first coin' })[r];

// History rows are slow to rebuild (the whole account), so keep them for the app run per account.
const rowsCache = new Map<string, { at: number; rows: HistoryRow[] }>();

type Series = { id: string; name: string; color: string; ys: number[]; dashed?: boolean };

/** % lines on one scale, zero line marked, end labels, and a scrub line that reads every series at a point. */
const CompareChart = ({ series, times }: { series: Series[]; times: number[] }) => {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 180;
  const all = series.flatMap((s) => s.ys).filter(Number.isFinite);
  if (all.length < 2 || times.length < 2) return null;
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const pad = (max - min) * 0.08 || 1;
  const y = (v: number) => H - 6 - ((v - (min - pad)) / (max - min + 2 * pad)) * (H - 12);
  const x = (i: number) => (i / (times.length - 1)) * W;
  const at = hover ?? times.length - 1;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-48 block touch-none"
        role="img"
        aria-label={series.map((s) => `${s.name} ${pct(s.ys[s.ys.length - 1])}`).join(', ')}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(
            Math.max(0, Math.min(times.length - 1, Math.round(((e.clientX - r.left) / r.width) * (times.length - 1)))),
          );
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="pf-you" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD} stopOpacity="0.28" />
            <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          x2={W}
          y1={y(0)}
          y2={y(0)}
          stroke="#ffffff22"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        {series.map((s) => {
          const pts = s.ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
          return (
            <g key={s.id}>
              {s.id === 'you' && <polygon points={`0,${y(0)} ${pts} ${W},${y(0)}`} fill="url(#pf-you)" />}
              <polyline
                points={pts}
                fill="none"
                stroke={s.color}
                strokeWidth={s.id === 'you' ? 2.6 : 1.4}
                strokeDasharray={s.dashed ? '4 4' : undefined}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                opacity={s.id === 'you' ? 1 : 0.85}
              />
            </g>
          );
        })}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="#ffffff44" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {series.map((s) => (
          <span key={s.id} className="flex items-center gap-1.5">
            <span className="w-3 h-[3px] rounded" style={{ background: s.color, opacity: s.dashed ? 0.6 : 1 }} />
            <span style={{ color: MUTED }}>{s.name}</span>
            <b style={{ color: tone(s.ys[at]) }}>{pct(s.ys[at])}</b>
          </span>
        ))}
        {hover !== null && (
          <span style={{ color: MUTED }}>
            {new Date(times[hover]).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: times[times.length - 1] - times[0] <= 2 * 86_400_000 ? '2-digit' : undefined,
              minute: times[times.length - 1] - times[0] <= 2 * 86_400_000 ? '2-digit' : undefined,
            })}
          </span>
        )}
      </div>
    </div>
  );
};

/** The account's dollar value over the range: gold area, start and end marked. */
const ValueChart = ({ ys }: { ys: number[] }) => {
  const W = 320;
  const H = 180;
  if (ys.length < 2) return null;
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const y = (v: number) => H - 6 - ((v - min) / (max - min || 1)) * (H - 24);
  const pts = ys.map((v, i) => `${((i / (ys.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-48 block"
      role="img"
      aria-label={`Value from ${formatUSD(ys[0])} to ${formatUSD(ys[ys.length - 1])}`}
    >
      <defs>
        <linearGradient id="pf-val" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={GOLD} stopOpacity="0.35" />
          <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="url(#pf-val)" />
      <polyline
        points={pts}
        fill="none"
        stroke={GOLD}
        strokeWidth="2.4"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const PortfolioScreen = ({
  onClose,
  onBsvChart,
  bsvSats,
  mneeUsd = 0,
  tokenCount = 0,
  price,
  dayChange,
}: {
  onClose: () => void;
  onBsvChart: () => void;
  /** Spendable BSV now (the wallet's balance). Locks are added from the account's lock plans. */
  bsvSats: number;
  mneeUsd?: number;
  /** Tokens held that have no market price here (shown, not valued). */
  tokenCount?: number;
  price: number;
  dayChange: number | null;
}) => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const addrs = account?.addresses;
  const idAddr = addrs?.identityAddress ?? '';
  const addresses = useMemo(
    () => [...new Set([addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress].filter((a): a is string => !!a))],
    [addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress],
  );
  const lockedSats = useMemo(() => {
    if (!idAddr) return 0;
    let s = 0;
    for (const p of loadPlans(idAddr, chromeStorageService))
      for (const piece of p.pieces) if (!piece.claimed) s += piece.sats;
    return s;
  }, [idAddr, chromeStorageService]);
  const nowSats = bsvSats + lockedSats;

  const [range, setRange] = useState<RangeId>('1M');
  const [view, setView] = useState<'compare' | 'value'>('compare');
  const [rows, setRows] = useState<HistoryRow[] | null>(rowsCache.get(idAddr)?.rows ?? null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [histError, setHistError] = useState('');
  const [bsv, setBsv] = useState<PricePoint[] | null>(null);
  const [btc, setBtc] = useState<PricePoint[] | null>(null);

  const loadRows = useCallback(
    async (force = false) => {
      const hit = rowsCache.get(idAddr);
      if (hit && !force && Date.now() - hit.at < 10 * 60_000) {
        setRows(hit.rows);
        return;
      }
      setHistError('');
      setProgress({ phase: 'Reading your history', done: 0, total: 1 });
      try {
        const r = await loadHistoryRows({ addresses, identityAddress: idAddr, apiContext, onProgress: setProgress });
        rowsCache.set(idAddr, { at: Date.now(), rows: r });
        setRows(r);
      } catch (e) {
        setHistError(e instanceof Error ? e.message : String(e));
      } finally {
        setProgress(null);
      }
    },
    [addresses, idAddr, apiContext],
  );

  useEffect(() => {
    if (addresses.length) void loadRows();
  }, [addresses.length, loadRows]);

  const now = useMemo(() => Date.now(), [rows, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = rows?.length ? Math.min(...rows.map((r) => r.time)) : undefined;
  const from = rangeStart(range, now, first);

  useEffect(() => {
    let live = true;
    setBsv(null);
    setBtc(null);
    void fetchSeries('bsv', range, from).then((s) => live && setBsv(s));
    void fetchSeries('btc', range, from).then((s) => live && setBtc(s));
    return () => {
      live = false;
    };
  }, [range, from]);

  const calc = useMemo(() => {
    if (!rows || !bsv?.length) return null;
    const times = sampleTimes(from, now, range === '1D' ? 48 : 96);
    const values = valueSeries(rows, nowSats, bsv, times, price > 0 ? price : undefined);
    const you = twrSeries(values, rows, bsv);
    const bsvPct = rebased(price > 0 ? [...bsv, { t: now, p: price }] : bsv, times);
    const btcPct = btc?.length ? rebased(btc, times) : [];
    return {
      times,
      values,
      you,
      bsvPct,
      btcPct,
      profit: profitUsd(values, rows, bsv),
      estimated: isEstimated(rows, values, nowSats),
      heldAtStart: values[0].sats > 0,
    };
  }, [rows, bsv, btc, from, now, range, nowSats, price]);

  const last = (a?: number[]) => (a && a.length ? a[a.length - 1] : null);
  const youPct = calc?.heldAtStart ? last(calc.you) : null;
  const bsvPct = last(calc?.bsvPct);
  const btcPct = last(calc?.btcPct);
  const bsvUsd = (bsvSats / 1e8) * price;
  const lockedUsd = (lockedSats / 1e8) * price;
  const holdings: Holding[] = [
    { id: 'bsv', name: 'BSV', usd: bsvUsd, changePct: bsvPct },
    { id: 'locked', name: 'Locked BSV', usd: lockedUsd, changePct: bsvPct },
    { id: 'mnee', name: 'MNEE (dollars)', usd: mneeUsd, changePct: 0 },
  ];
  const rank = rankHoldings(holdings);
  const totalUsd = rank.total;

  const series: Series[] = calc
    ? [
        ...(calc.heldAtStart ? [{ id: 'you', name: 'You', color: GOLD, ys: calc.you }] : []),
        { id: 'bsv', name: 'Hold BSV', color: BSV_C, ys: calc.bsvPct },
        ...(calc.btcPct.length ? [{ id: 'btc', name: 'Hold BTC', color: BTC_C, ys: calc.btcPct }] : []),
        { id: 'usd', name: 'Dollars', color: MUTED, ys: calc.times.map(() => 0), dashed: true },
      ]
    : [];

  const verdict = (() => {
    if (youPct === null) return null;
    const vs =
      btcPct !== null ? { name: 'BTC', v: btcPct } : bsvPct !== null ? { name: 'holding BSV', v: bsvPct } : null;
    if (!vs) return null;
    const d = youPct - vs.v;
    if (Math.abs(d) < 0.05) return `You kept pace with ${vs.name} ${rangeWord(range)}.`;
    return `You ${d > 0 ? 'beat' : 'trailed'} ${vs.name} by ${Math.abs(d).toFixed(Math.abs(d) < 10 ? 2 : 1)} points ${rangeWord(range)}.`;
  })();

  const loadingHistory = !!progress;
  const marketDown = bsv !== null && bsv.length === 0;

  return createPortal(
    <div
      role="dialog"
      aria-label="Portfolio vs market"
      className="fixed inset-0 flex flex-col"
      style={{ background: BG, color: '#fff', zIndex: 2000, paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">Portfolio vs market</div>
          <div className="text-xs truncate" style={{ color: MUTED }}>
            {account?.name || 'This account'}
          </div>
        </div>
        <button
          type="button"
          aria-label="Reload"
          disabled={loadingHistory}
          onClick={() => void loadRows(true)}
          className="p-2 bg-transparent border-0 cursor-pointer"
          style={{ color: MUTED }}
        >
          <RefreshCw size={18} className={loadingHistory ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="p-2 bg-transparent border-0 cursor-pointer"
          style={{ color: '#fff' }}
        >
          <X size={20} />
        </button>
      </div>

      <div
        className="flex-1 overflow-y-auto px-4 pb-10"
        style={{ paddingBottom: 'calc(2.5rem + env(safe-area-inset-bottom))' }}
      >
        {/* Hero: what it's worth now and how the range went */}
        <div className="pt-5 pb-3">
          <div className="text-xs" style={{ color: MUTED }}>
            Your portfolio
          </div>
          <div className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.02em' }}>
            {price > 0 ? formatUSD(totalUsd) : '—'}
          </div>
          {calc && rows && (
            <div className="mt-1 text-sm font-semibold flex items-center gap-1.5" style={{ color: tone(calc.profit) }}>
              {calc.profit >= 0 ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
              {calc.profit >= 0 ? '+' : '−'}
              {formatUSD(Math.abs(calc.profit))}
              {youPct !== null && <span>({pct(youPct)})</span>}
              <span className="font-normal" style={{ color: MUTED }}>
                {rangeWord(range)}
              </span>
            </div>
          )}
          {verdict && (
            <div className="mt-2 text-[13px]" style={{ color: '#F1EAD9' }}>
              {verdict}
            </div>
          )}
        </div>

        {/* Range */}
        <div className="flex gap-1.5" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              onClick={() => setRange(r)}
              className="flex-1 h-9 rounded-lg text-xs font-bold border cursor-pointer"
              style={{
                background: range === r ? GOLD : 'transparent',
                color: range === r ? '#1a1300' : '#fff',
                borderColor: range === r ? GOLD : LINE,
              }}
            >
              {r === 'ALL' ? 'All' : r}
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="mt-3 rounded-2xl border p-3" style={{ background: CARD, borderColor: LINE }}>
          <div className="flex gap-1 mb-2" role="tablist" aria-label="Chart">
            {(
              [
                ['compare', 'vs market'],
                ['value', 'Value'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className="px-3 h-7 rounded-full text-xs font-semibold border-0 cursor-pointer"
                style={{ background: view === id ? '#2E2510' : 'transparent', color: view === id ? GOLD : MUTED }}
              >
                {label}
              </button>
            ))}
          </div>
          {loadingHistory && !rows ? (
            <div className="h-48 grid place-items-center text-center text-xs" style={{ color: MUTED }}>
              <div>
                <RefreshCw size={18} className="animate-spin mx-auto mb-2" />
                {progress?.phase ?? 'Loading'}
                {progress && progress.total > 1 ? ` · ${Math.round((progress.done / progress.total) * 100)}%` : ''}
              </div>
            </div>
          ) : marketDown ? (
            <div className="h-48 grid place-items-center text-center text-sm px-6" style={{ color: MUTED }}>
              Market prices aren't reachable right now. Check your connection and tap reload.
            </div>
          ) : !calc ? (
            <div className="h-48 grid place-items-center text-xs" style={{ color: MUTED }}>
              {histError ? `Couldn't read your history: ${histError}` : 'Loading prices…'}
            </div>
          ) : view === 'compare' ? (
            <CompareChart series={series} times={calc.times} />
          ) : (
            <ValueChart ys={calc.values.map((v) => v.usd)} />
          )}
          {calc && !calc.heldAtStart && view === 'compare' && (
            <div className="mt-2 text-xs" style={{ color: MUTED }}>
              You held no BSV at the start of this range, so there's no return to compare yet. Try a shorter range.
            </div>
          )}
        </div>

        {/* Scoreboard */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            { name: 'You', v: youPct, c: GOLD },
            { name: 'Hold BSV', v: bsvPct, c: BSV_C },
            { name: 'Hold BTC', v: btcPct, c: BTC_C },
            { name: 'Keep dollars', v: calc ? 0 : null, c: MUTED },
          ].map((s) => (
            <div key={s.name} className="rounded-xl border px-3 py-2.5" style={{ background: CARD, borderColor: LINE }}>
              <div className="flex items-center gap-1.5 text-xs" style={{ color: MUTED }}>
                <span className="w-2 h-2 rounded-full" style={{ background: s.c }} />
                {s.name}
              </div>
              <div className="text-lg font-bold" style={{ color: tone(s.v) }}>
                {pct(s.v)}
              </div>
            </div>
          ))}
        </div>

        {/* Holdings */}
        <div className="mt-5 text-sm font-bold">What you hold</div>
        {rank.held.length > 0 ? (
          <>
            <div
              className="mt-2 h-2.5 rounded-full overflow-hidden flex"
              aria-hidden="true"
              style={{ background: LINE }}
            >
              {rank.held.map((h) => (
                <span
                  key={h.id}
                  style={{
                    width: `${rank.share(h)}%`,
                    background: h.id === 'bsv' ? GOLD : h.id === 'locked' ? '#B8860B' : '#7DD3FC',
                  }}
                />
              ))}
            </div>
            <div className="mt-2 rounded-2xl border divide-y" style={{ background: CARD, borderColor: LINE }}>
              {rank.held.map((h) => (
                <div key={h.id} className="flex items-center gap-3 px-3 py-2.5" style={{ borderColor: LINE }}>
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: h.id === 'bsv' ? GOLD : h.id === 'locked' ? '#B8860B' : '#7DD3FC' }}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold">{h.name}</span>
                    <span className="block text-xs" style={{ color: MUTED }}>
                      {rank.share(h).toFixed(0)}% of your portfolio
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-semibold">{formatUSD(h.usd)}</span>
                    <span className="block text-xs" style={{ color: tone(h.changePct) }}>
                      {pct(h.changePct)} {rangeWord(range)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {(rank.best || rank.worst) && (
              <div className="mt-2 flex gap-2 text-xs">
                {rank.best && (
                  <span className="flex-1 rounded-xl px-3 py-2" style={{ background: '#0f2a1d', color: UP }}>
                    Best: {rank.best.name} {pct(rank.best.changePct)}
                  </span>
                )}
                {rank.worst && (
                  <span className="flex-1 rounded-xl px-3 py-2" style={{ background: '#2a1414', color: DOWN }}>
                    Worst: {rank.worst.name} {pct(rank.worst.changePct)}
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <div
            className="mt-2 rounded-2xl border px-4 py-5 text-sm text-center"
            style={{ background: CARD, borderColor: LINE, color: MUTED }}
          >
            Nothing here yet. Buy or receive some BSV and this screen will start tracking how it does.
          </div>
        )}
        {tokenCount > 0 && (
          <div className="mt-2 text-xs" style={{ color: MUTED }}>
            Plus {tokenCount} token{tokenCount === 1 ? '' : 's'} with no market price here, so they aren't counted in
            the total.
          </div>
        )}

        {/* BSV price + the chart */}
        <div
          className="mt-5 rounded-2xl border p-4 flex items-center gap-3"
          style={{ background: CARD, borderColor: LINE }}
        >
          <div className="flex-1">
            <div className="text-xs" style={{ color: MUTED }}>
              BSV price
            </div>
            <div className="text-xl font-bold">{price > 0 ? formatUSD(price) : '—'}</div>
            <div className="text-xs font-semibold" style={{ color: tone(dayChange) }}>
              {dayChange === null ? 'per BSV' : `${pct(dayChange)} today`}
            </div>
          </div>
          <button
            type="button"
            onClick={onBsvChart}
            className="h-11 px-4 rounded-xl border-0 flex items-center gap-2 text-sm font-bold cursor-pointer"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            <LineChart size={16} />
            BSV chart
          </button>
        </div>

        {/* Honest notes */}
        <div className="mt-4 text-[11px] leading-relaxed" style={{ color: MUTED }}>
          How this is worked out: your BSV (including locks) on each day, from your transaction history, × that day's
          BSV price. Money you send in or out isn't counted as gain or loss; fees are. Tokens aren't in the line because
          their past prices aren't known. Prices: CoinGecko and WhatsOnChain.
          {calc?.estimated && (
            <span className="block mt-1" style={{ color: '#F5C542' }}>
              Estimated: some days had no price, so the nearest earlier or today's price was used.
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default PortfolioScreen;
