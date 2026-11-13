import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { roomMarket, type HotRoom, type Listing } from '../market/indexer';
import { RISK_LINE } from '../feed/reels/bexCards';
import { TokenIcon } from './TokenIcon';
import { tradeRoute } from './exchangeData';
import { buyRoute } from './rowActions';
import { bestBuyable, buyPriceLabel, compactCount, forSaleFirst, listingTokens, saleState } from './buyPrice';
import { SCORE_RULES, type FairScore } from './boardFacts';
import { marketTradingEnabled } from '../storeBuild';

/**
 * Exchange › Tokens as cards (owner, 13 Nov 2026: "so TMI... Users just want to see what they can buy, and a
 * button to buy it"): each card is the token's icon, its $NAME, the price to buy now and one Buy button.
 * Everything else (fair-launch score, verified badges, deployer, age, market cap, supply, burned, 24h change)
 * lives on the token's page under Details (TokenDetails.tsx). Tokens with a listing you can buy come first.
 *
 * De minimis (owner, 15 Oct 2026): no "Trending / Hot / Pumping" labels, no flames or rockets, no featured
 * coins, and the risk line on the board. Prices load a few cards at a time from the cached market data
 * (indexer.roomMarket), as the list view does.
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const GREEN = '#A1FF8B';
const LINE = '#2b2f36';
const PAGE = 24;

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

const TRADING = marketTradingEnabled();

/** One token: icon, $NAME, the price to buy now, and Buy. Tapping anywhere else opens the token's page. */
const TokenCard = ({
  r,
  listings,
  rate,
  onOpen,
  onBuy,
}: {
  r: HotRoom;
  /** The token's live listings; undefined while they load. */
  listings: Listing[] | undefined;
  rate: number;
  onOpen: (r: HotRoom) => void;
  onBuy: (r: HotRoom) => void;
}) => {
  const name = r.title.replace(/^\$/, '');
  const best = listings ? bestBuyable(listings) : null;
  const tokens = best ? listingTokens(best) : null;
  const price = best ? buyPriceLabel(best.priceSats, rate) : null;
  const canBuy = !!best && TRADING;
  return (
    <article
      role="listitem"
      aria-label={`$${name}${price ? `, ${price} to buy` : listings ? ', not for sale' : ''}`}
      className="relative rounded-2xl px-3.5 py-3 flex items-center gap-3 min-w-0 transition-colors"
      style={{ background: 'var(--bw-surface)', border: `1px solid ${LINE}` }}
    >
      <button
        type="button"
        onClick={() => onOpen(r)}
        aria-label={`Open $${name}`}
        className="absolute inset-0 rounded-2xl bg-transparent border-0 cursor-pointer hover:bg-white/[0.02]"
      />
      <span className="pointer-events-none shrink-0">
        <TokenIcon icon={r.icon} sym={r.title} size={44} />
      </span>
      <span className="flex flex-col min-w-0 flex-1 pointer-events-none">
        <span className="text-base font-extrabold text-white truncate">${name}</span>
        <span className="text-xs truncate" style={{ color: MUTED }} data-testid="buy-price">
          {!listings ? (
            'Checking price…'
          ) : price ? (
            <>
              <span className="font-bold text-white">{price}</span>
              {tokens !== null && ` for ${compactCount(tokens)}`}
            </>
          ) : (
            'Not for sale'
          )}
        </span>
      </span>
      {canBuy ? (
        <button
          type="button"
          onClick={() => onBuy(r)}
          aria-label={`Buy $${name}${price ? ` from ${price}` : ''}`}
          className="relative z-10 shrink-0 min-w-[72px] min-h-[44px] px-4 rounded-xl text-sm font-extrabold border-0 cursor-pointer"
          style={{ background: GOLD, color: '#000' }}
        >
          Buy
        </button>
      ) : (
        listings && (
          <button
            type="button"
            onClick={() => onOpen(r)}
            aria-label={`View $${name}`}
            className="relative z-10 shrink-0 min-w-[72px] min-h-[44px] px-4 rounded-xl text-sm font-bold bg-transparent cursor-pointer"
            style={{ border: `1px solid ${LINE}`, color: MUTED }}
          >
            View
          </button>
        )
      )}
    </article>
  );
};

export const TokenBoard = ({
  list,
  rate,
  onOpen: onOpenIn,
  onBuy: onBuyIn,
}: {
  list: HotRoom[];
  rate: number;
  /** Open a token; default: the Exchange trade screen. */
  onOpen?: (r: HotRoom) => void;
  /** Buy a token; default: the trade screen at its Buy panel (rowActions.buyRoute), the existing buy flow. */
  onBuy?: (r: HotRoom) => void;
}) => {
  const navigate = useNavigate();
  const onOpen = onOpenIn ?? ((r: HotRoom) => navigate(tradeRoute(r.ref.id)));
  const onBuy = onBuyIn ?? ((r: HotRoom) => navigate(buyRoute(r.ref.id)));
  const [markets, setMarkets] = useState<Record<string, Listing[]>>({});
  const [shown, setShown] = useState(PAGE);
  const page = list.slice(0, shown);
  const visibleKey = page.map((r) => r.ref.id).join(',');
  // For sale first (a listing you can buy in-app), then still checking, then not for sale; otherwise the
  // list's own order (pinned and favourites first on the Exchange).
  const ordered = useMemo(
    () => forSaleFirst(page, (r) => saleState(markets[r.ref.id])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleKey, markets],
  );

  // Listings for the cards on screen, four at a time. roomMarket is cached and shared with the token board's
  // own ranking and the list view, so most cards resolve without a new request.
  useEffect(() => {
    let live = true;
    const queue = page.filter((r) => !markets[r.ref.id]);
    const worker = async () => {
      for (let r = queue.shift(); r && live; r = queue.shift()) {
        const id = r.ref.id;
        const m = await roomMarket(r.ref).catch(() => null);
        if (!live) return;
        setMarkets((x) => ({ ...x, [id]: m?.listings ?? [] }));
      }
    };
    void Promise.all([worker(), worker(), worker(), worker()]);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  return (
    <div className="flex flex-col gap-3 w-full min-w-0">
      <p className="text-xs m-0" style={{ color: MUTED }} data-testid="risk-line">
        {RISK_LINE}
      </p>
      <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3" role="list" aria-label="Tokens">
        {ordered.map((r) => (
          <TokenCard key={r.ref.id} r={r} listings={markets[r.ref.id]} rate={rate} onOpen={onOpen} onBuy={onBuy} />
        ))}
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
  );
};
