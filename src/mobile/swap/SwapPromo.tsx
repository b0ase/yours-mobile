import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { POPULAR_COINS, safeCoinImage, SwapApi, type SwapCoin, type SwapRecord } from './swapApi';
import { stageLabel } from './promo';

/**
 * Wallet-screen promo card under the Swap · Buy · History row (owner, 10 Oct 2026): replaces the plain text line
 * "Have BTC, ETH or USDT? Swap it into BSV here". Slim black/gold card, three overlapping coin logos, title,
 * subtitle, chevron; the whole card opens Swap. While a swap runs it shows "Swap in progress · <stage>" with the
 * gold pulse dot. Permanent (owner, 10 Oct 2026: no close button; people who hid it couldn't get it back, so an
 * old 'bwx.swapPromoDismissed' flag is ignored). bWalletX only (lazy chunk, SWAP_ENABLED in BuyBsv.tsx).
 */
const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const PROMO: SwapCoin[] = [POPULAR_COINS[0], POPULAR_COINS[1], POPULAR_COINS[2]]; // BTC, ETH, USDT
let imgCache: SwapCoin[] | null = null;

const Logo = ({ coin, i }: { coin: SwapCoin; i: number }) => {
  const src = safeCoinImage(coin.image);
  const [bad, setBad] = useState(false);
  const t = coin.ticker.toUpperCase();
  const common = { width: 22, height: 22, marginLeft: i ? -7 : 0, zIndex: 3 - i, border: '2px solid #17191E' } as const;
  return src && !bad ? (
    <img
      src={src}
      alt=""
      width={22}
      height={22}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBad(true)}
      className="rounded-full object-contain relative"
      style={{ ...common, background: '#fff' }}
    />
  ) : (
    <span
      aria-hidden="true"
      className="rounded-full grid place-items-center text-[10px] font-bold relative"
      style={{ ...common, background: '#4A3F25', color: '#F1EAD9' }}
    >
      {t.charAt(0)}
    </span>
  );
};

export const SwapPromo = ({ active, onOpen }: { active: SwapRecord | null; onOpen: () => void }) => {
  const [coins, setCoins] = useState<SwapCoin[]>(imgCache ?? PROMO);
  useEffect(() => {
    if (imgCache) return;
    new SwapApi()
      .currencies()
      .then((r) => {
        const img = new Map((r.currencies ?? []).map((c) => [`${c.ticker}:${c.network}`, c.image]));
        imgCache = PROMO.map((c) => ({ ...c, image: img.get(`${c.ticker}:${c.network}`) ?? null }));
        setCoins(imgCache);
      })
      .catch(() => undefined);
  }, []);

  const title = active ? 'Swap in progress' : 'Swap into BSV';
  const sub = active ? stageLabel(active.stage) : 'From BTC, ETH, USDT and 1,000+ coins';
  return (
    <div className="w-[92%] -mb-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={active ? `${title}, ${sub}. Open to track it` : `${title}. ${sub}`}
        className="w-full min-h-[52px] pl-3 pr-3 py-2 rounded-xl border flex items-center gap-3 text-left cursor-pointer"
        style={{ background: '#17191E', borderColor: active ? '#f5b80099' : '#2b2f36' }}
      >
        {active ? (
          <span className="relative w-[22px] h-[22px] grid place-items-center shrink-0" aria-hidden="true">
            <span className="absolute w-2.5 h-2.5 rounded-full animate-ping opacity-60" style={{ background: GOLD }} />
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: GOLD }} />
          </span>
        ) : (
          <span className="flex items-center shrink-0" aria-hidden="true">
            {coins.map((c, i) => (
              <Logo key={`${c.ticker}:${c.network}`} coin={c} i={i} />
            ))}
          </span>
        )}
        <span className="flex-1 min-w-0 flex flex-col leading-tight">
          <span className="text-[14px] font-bold" style={{ color: active ? GOLD : '#fff' }}>
            {title}
            {active && (
              <span className="font-semibold" style={{ color: '#fff' }}>
                {' '}
                · {sub}
              </span>
            )}
          </span>
          {!active && (
            <span className="text-[11px] truncate" style={{ color: MUTED }}>
              {sub}
            </span>
          )}
        </span>
        <ChevronRight size={18} color={MUTED} aria-hidden="true" className="shrink-0" />
      </button>
    </div>
  );
};

export default SwapPromo;
