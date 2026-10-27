import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flame, Info, ShieldCheck, Sparkles, TrendingUp, Users, X } from 'lucide-react';
import type { HotRoom } from '../market/indexer';
import { TokenIcon } from './TokenIcon';
import { bsvLabel, chainTip, changeLabel, dayStats, tokenTrades, tradeRoute, type DayStats } from './exchangeData';
import {
  SCORE_RULES,
  ageLabel,
  capLabel,
  badges,
  boardFacts,
  derive,
  fairScore,
  shortAmount,
  type Badge,
  type BoardFacts,
  type FairScore,
} from './boardFacts';

/**
 * Exchange › Tokens as cards: icon, ticker, verified badges, deployer + age, supply facts, market cap, the
 * fair-launch score, holders, and Trending / New coins. Facts load a few cards at a time (cached), as the
 * list view does. See boardFacts.ts for what each badge proves.
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const GREEN = '#A1FF8B';
const RED = '#FF6B6B';
const LINE = '#2b2f36';
const PAGE = 24;

type Card = {
  facts: BoardFacts | null;
  stats: DayStats;
  score: FairScore | null;
  badges: Badge[];
  /** Market cap in sats (last trade × circulating), null when never traded. */
  mcap: number | null;
  burnedLabel: string | null;
};

const short = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

const scoreColour = (n: number) => (n >= 70 ? GREEN : n >= 40 ? '#F5C518' : '#FF9F6B');

export const ScoreRing = ({ n }: { n: number }) => {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" aria-hidden>
      <circle cx={22} cy={22} r={r} fill="none" stroke={LINE} strokeWidth={4} />
      <circle
        cx={22}
        cy={22}
        r={r}
        fill="none"
        stroke={scoreColour(n)}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${(c * n) / 100} ${c}`}
        transform="rotate(-90 22 22)"
      />
      <text x={22} y={26} textAnchor="middle" fontSize={12} fontWeight={800} fill="#fff">
        {n}
      </text>
    </svg>
  );
};

/** The open formula, plus this token's own breakdown when one is picked. */
export const ScoreSheet = ({
  onClose,
  token,
}: {
  onClose: () => void;
  token: { title: string; score: FairScore } | null;
}) => (
  <div
    role="dialog"
    aria-modal="true"
    aria-label="How the fair-launch score works"
    className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/70"
    onClick={onClose}
  >
    <div
      className="w-full sm:max-w-[480px] max-h-[85vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl p-5 flex flex-col gap-3"
      style={{ background: 'var(--bw-surface)', border: `1px solid ${LINE}` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-extrabold text-white m-0">
          {token ? `${token.title}: ${token.score.total}/100` : "How it's scored"}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="w-11 h-11 grid place-items-center rounded-full bg-transparent border-0 cursor-pointer"
        >
          <X size={20} color={MUTED} />
        </button>
      </div>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        The fair-launch score adds five parts, out of 100. Every input is read from the chain and checked by this
        wallet: the deploy transaction, the supply, and holder balances. A part the wallet can't check scores 0.
      </p>
      {SCORE_RULES.map((r) => {
        const mine = token?.score.parts.find((p) => p.id === r.id);
        return (
          <div key={r.id} className="rounded-2xl p-3 flex flex-col gap-1" style={{ border: `1px solid ${LINE}` }}>
            <div className="flex items-center justify-between text-sm font-bold text-white">
              <span>{r.label}</span>
              <span style={{ color: GOLD }}>{mine ? `${mine.points} / ${r.max}` : `up to ${r.max}`}</span>
            </div>
            {mine && <span className="text-xs text-white">{mine.note}</span>}
            <span className="text-[11px]" style={{ color: MUTED }}>
              {r.rule}
            </span>
          </div>
        );
      })}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        Burn addresses don't count as holders. Token locks, holder payouts and fee splits aren't scored yet: the wallet
        can't check them per token. The score describes how a token's supply is spread; it says nothing about its price.
      </p>
    </div>
  </div>
);

const TokenCard = ({
  r,
  card,
  tip,
  rate,
  onScore,
  onOpen,
}: {
  onOpen: (r: HotRoom) => void;
  r: HotRoom;
  card: Card | undefined;
  tip: number;
  rate: number;
  onScore: () => void;
}) => {
  const f = card?.facts ?? null;
  const ch = card?.stats.change ?? null;
  const open = () => onOpen(r);
  const name = r.title.replace(/^\$/, '');
  return (
    <article
      role="listitem"
      className="relative rounded-2xl p-3.5 flex flex-col gap-2.5 min-w-0 transition-colors"
      style={{
        background: 'linear-gradient(180deg, rgba(245,197,24,0.05), rgba(0,0,0,0) 40%), var(--bw-surface)',
        border: `1px solid ${LINE}`,
      }}
    >
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${r.title}`}
        className="absolute inset-0 rounded-2xl bg-transparent border-0 cursor-pointer hover:bg-white/[0.02]"
      />
      <div className="flex items-start gap-3 min-w-0 pointer-events-none">
        <TokenIcon icon={r.icon} sym={r.title} size={48} />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-base font-extrabold text-white truncate">${name}</span>
            {ch !== null && (
              <span className="text-xs font-bold shrink-0" style={{ color: ch >= 0 ? GREEN : RED }}>
                {changeLabel(ch)}
              </span>
            )}
          </span>
          <span className="text-[11px] truncate" style={{ color: MUTED }}>
            {f
              ? `${f.deployer ? `by ${short(f.deployer)}` : 'BSV-21'}${f.height && tip ? ` · ${ageLabel(tip - f.height)} ago` : ''}`
              : card
                ? 'BSV-21 token'
                : 'Checking the chain…'}
          </span>
        </div>
        {card?.score && (
          <button
            type="button"
            onClick={onScore}
            aria-label={`Fair-launch score ${card.score.total} of 100. How it's scored`}
            className="pointer-events-auto relative z-10 -m-1 p-0 min-w-[44px] min-h-[44px] grid place-items-center bg-transparent border-0 cursor-pointer"
          >
            <ScoreRing n={card.score.total} />
          </button>
        )}
      </div>

      {card && card.badges.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 m-0 p-0 list-none pointer-events-none" aria-label="Verified facts">
          {card.badges.map((b) => (
            <li
              key={b.id}
              title={b.detail}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: 'rgba(245,197,24,0.08)', border: '1px solid rgba(245,197,24,0.28)', color: GOLD }}
            >
              {b.id === 'burned' ? <Flame size={11} /> : <ShieldCheck size={11} />}
              {b.label}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-2 pointer-events-none">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
            Market cap
          </span>
          <span className="text-sm font-bold text-white">
            {!card ? '…' : card.mcap === null ? '—' : capLabel(card.mcap, rate)}
          </span>
          {card?.mcap != null && rate > 0 && (
            <span className="text-[10px]" style={{ color: MUTED }}>
              {capLabel(card.mcap, 0)} · at last trade
            </span>
          )}
        </div>
        <div className="flex flex-col items-end text-right">
          <span className="text-[10px] uppercase tracking-wide" style={{ color: MUTED }}>
            Supply
          </span>
          <span className="text-sm font-bold text-white">{f ? shortAmount(f.supply, f.dec) : '…'}</span>
          {card?.burnedLabel && (
            <span className="text-[10px]" style={{ color: MUTED }}>
              {card.burnedLabel}
            </span>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-between gap-2 pt-2 text-[11px] pointer-events-none"
        style={{ borderTop: `1px solid ${LINE}`, color: MUTED }}
      >
        <span className="flex items-center gap-1">
          <Users size={12} /> {f?.holders != null ? f.holders.toLocaleString('en-US') : '—'} holders
        </span>
        <span>
          {card?.stats.trades ? `${card.stats.trades} trades · ${bsvLabel(card.stats.volume)} 24h` : 'No trades 24h'}
        </span>
      </div>
    </article>
  );
};

const SideList = ({
  title,
  icon,
  rows,
  empty,
  onOpen,
}: {
  onOpen: (r: HotRoom) => void;
  title: string;
  icon: JSX.Element;
  rows: { r: HotRoom; right: JSX.Element }[];
  empty: string;
}) => {
  return (
    <section
      className="rounded-2xl p-3 flex flex-col gap-1 min-w-0"
      style={{ background: 'var(--bw-surface)', border: `1px solid ${LINE}` }}
      aria-label={title}
    >
      <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-white m-0 px-1 pb-1">
        {icon}
        {title}
      </h3>
      {!rows.length && (
        <p className="text-xs m-0 px-1 py-2" style={{ color: MUTED }}>
          {empty}
        </p>
      )}
      {rows.map(({ r, right }) => (
        <button
          key={r.ref.id}
          type="button"
          onClick={() => onOpen(r)}
          className="flex items-center gap-2 min-h-[44px] px-1 rounded-xl bg-transparent border-0 cursor-pointer hover:bg-white/[0.03] text-left"
        >
          <TokenIcon icon={r.icon} sym={r.title} size={28} />
          <span className="flex-1 min-w-0 truncate text-sm font-bold text-white">{r.title}</span>
          {right}
        </button>
      ))}
    </section>
  );
};

export const TokenBoard = ({
  list,
  rate,
  onOpen: onOpenIn,
}: {
  list: HotRoom[];
  rate: number;
  /** Open a token; default: the Exchange trade screen. */
  onOpen?: (r: HotRoom) => void;
}) => {
  const navigate = useNavigate();
  const onOpen = onOpenIn ?? ((r: HotRoom) => navigate(tradeRoute(r.ref.id)));
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [shown, setShown] = useState(PAGE);
  const [tip, setTip] = useState(0);
  const [sheet, setSheet] = useState<{ title: string; score: FairScore } | null | false>(false);
  const visible = list.slice(0, shown);
  const visibleKey = visible.map((r) => r.ref.id).join(',');

  useEffect(() => {
    let live = true;
    const todo = visible.filter((r) => !cards[r.ref.id]);
    void (async () => {
      const t = await chainTip();
      if (live) setTip(t);
      const queue = [...todo];
      const worker = async () => {
        for (let r = queue.shift(); r && live; r = queue.shift()) {
          const id = r.ref.id;
          const [facts, trades] = await Promise.all([boardFacts(id).catch(() => null), tokenTrades(id)]);
          if (!live) return;
          const stats = dayStats(trades, t);
          const d = facts ? derive(facts) : null;
          const mcap =
            facts && d && stats.last !== null
              ? Math.round((stats.last * Number(d.circulating)) / 10 ** facts.dec)
              : null;
          setCards((c) => ({
            ...c,
            [id]: {
              facts,
              stats,
              score: facts ? fairScore(facts, d!) : null,
              badges: facts ? badges(facts, d!) : [],
              mcap,
              burnedLabel: facts && d && d.burned > 0n ? `${shortAmount(d.burned, facts.dec)} burned` : null,
            },
          }));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  const trending = useMemo(
    () =>
      list
        .filter((r) => cards[r.ref.id]?.stats.change != null && cards[r.ref.id].stats.trades >= 2)
        .sort((a, b) => (cards[b.ref.id].stats.change ?? 0) - (cards[a.ref.id].stats.change ?? 0))
        .slice(0, 6),
    [list, cards],
  );
  const fresh = useMemo(
    () =>
      list
        .filter((r) => (cards[r.ref.id]?.facts?.height ?? 0) > 0)
        .sort((a, b) => cards[b.ref.id].facts!.height - cards[a.ref.id].facts!.height)
        .slice(0, 6),
    [list, cards],
  );

  const side = (n: number) => (
    <>
      {trending.length > 0 && (
        <SideList
          onOpen={onOpen}
          title="Trending"
          icon={<TrendingUp size={15} color={GOLD} />}
          empty=""
          rows={trending.slice(0, n).map((r) => {
            const c = cards[r.ref.id].stats.change;
            return {
              r,
              right: (
                <span className="text-xs font-bold" style={{ color: (c ?? 0) >= 0 ? GREEN : RED }}>
                  {changeLabel(c)}
                </span>
              ),
            };
          })}
        />
      )}
      <SideList
        onOpen={onOpen}
        title="New coins"
        icon={<Sparkles size={15} color={GOLD} />}
        empty="Checking deploy dates…"
        rows={fresh.slice(0, n).map((r) => ({
          r,
          right: (
            <span className="text-xs" style={{ color: MUTED }}>
              {tip ? `${ageLabel(tip - cards[r.ref.id].facts!.height)} ago` : ''}
            </span>
          ),
        }))}
      />
    </>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] w-full">
      <div className="grid gap-3 sm:grid-cols-2 lg:hidden">{side(3)}</div>
      <div className="flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: MUTED }}>
            Badges show only what the wallet checked on chain.
          </span>
          <button
            type="button"
            onClick={() => setSheet(null)}
            className="flex items-center gap-1.5 min-h-[44px] px-3 rounded-xl text-xs font-bold bg-transparent cursor-pointer shrink-0"
            style={{ border: `1px solid ${LINE}`, color: GOLD }}
          >
            <Info size={14} /> How it's scored
          </button>
        </div>
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Tokens">
          {visible.map((r) => {
            const card = cards[r.ref.id];
            return (
              <TokenCard
                key={r.ref.id}
                r={r}
                card={card}
                tip={tip}
                rate={rate}
                onOpen={onOpen}
                onScore={() => card?.score && setSheet({ title: r.title, score: card.score })}
              />
            );
          })}
        </div>
        {list.length > shown && (
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="w-full min-h-[44px] rounded-xl text-sm font-bold bg-transparent cursor-pointer"
            style={{ border: `1px solid ${LINE}`, color: GOLD }}
          >
            Show more ({list.length - shown})
          </button>
        )}
      </div>
      <aside className="hidden lg:flex flex-col gap-3">{side(6)}</aside>
      {sheet !== false && <ScoreSheet token={sheet} onClose={() => setSheet(false)} />}
    </div>
  );
};
