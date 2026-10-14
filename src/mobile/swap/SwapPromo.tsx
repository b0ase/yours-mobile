import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { POPULAR_COINS, safeCoinImage, type SwapCoin, type SwapRecord } from './swapApi';
import { stageLabel } from './promo';

/**
 * Wallet-screen promo card under the Swap · Buy · History row (owner, 10 Oct 2026): replaces the plain text line
 * "Have BTC, ETH or USDT? Swap it into BSV here". Slim black/gold card, three overlapping coin logos, title,
 * subtitle, chevron; the whole card opens Swap. While a swap runs it shows "Swap in progress · <stage>" with the
 * gold pulse dot. Permanent (owner, 10 Oct 2026: no close button; people who hid it couldn't get it back, so an
 * old 'bwx.swapPromoDismissed' flag is ignored). bWalletX only (lazy chunk, SWAP_ENABLED in BuyBsv.tsx).
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
// Drawn in-app so the three logos show at once, with no wait on (or failure of) the swap service's image list.
const svg = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;
const BUILT_IN_LOGOS: Record<string, string> = {
  btc: svg(
    '<circle cx="16" cy="16" r="16" fill="#F7931A"/><text x="16" y="22.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="700" fill="#fff">\u20bf</text>',
  ),
  eth: svg(
    '<circle cx="16" cy="16" r="16" fill="#627EEA"/><path fill="#fff" fill-opacity=".6" d="M16 4v8.9l7.5 3.3z"/><path fill="#fff" d="M16 4 8.5 16.2l7.5-3.3z"/><path fill="#fff" fill-opacity=".6" d="M16 22v6l7.5-10.4z"/><path fill="#fff" d="M16 28v-6l-7.5-4.4z"/><path fill="#fff" fill-opacity=".2" d="m16 20.6 7.5-4.4L16 12.9z"/><path fill="#fff" fill-opacity=".6" d="m8.5 16.2 7.5 4.4v-7.7z"/>',
  ),
  usdt: svg(
    '<circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#fff" d="M17.9 17.4v0c-.1 0-.7.1-1.9.1-1 0-1.7 0-1.9-.1v0c-3.8-.2-6.6-.8-6.6-1.6s2.8-1.5 6.6-1.6v2.6c.3 0 1 .1 1.9.1 1.1 0 1.7-.1 1.9-.1v-2.6c3.8.2 6.6.8 6.6 1.6s-2.8 1.4-6.6 1.6m0-3.5V11.6h5.3V8H8.8v3.6h5.3v2.3c-4.3.2-7.5 1-7.5 2s3.2 1.8 7.5 2v7.3h3.8v-7.3c4.3-.2 7.5-1 7.5-2s-3.2-1.8-7.5-2"/>',
  ),
};
const PROMO: SwapCoin[] = [POPULAR_COINS[0], POPULAR_COINS[1], POPULAR_COINS[2]].map((c) => ({
  ...c,
  image: BUILT_IN_LOGOS[c.ticker] ?? null,
})); // BTC, ETH, USDT

const Logo = ({ coin, i }: { coin: SwapCoin; i: number }) => {
  const src = coin.image?.startsWith('data:image/svg+xml,') ? coin.image : safeCoinImage(coin.image);
  const [bad, setBad] = useState(false);
  const t = coin.ticker.toUpperCase();
  const common = { width: 22, height: 22, marginLeft: i ? -7 : 0, zIndex: 3 - i, border: '2px solid #17191E' } as const;
  return src && !bad ? (
    <img
      src={src}
      alt=""
      width={22}
      height={22}
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
  const coins = PROMO;

  const title = active ? 'Swap in progress' : 'Swap into BSV';
  const sub = active ? stageLabel(active.stage) : 'From BTC, ETH, USDT and 1,000+ coins';
  return (
    <div className="w-[92%] -mb-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={active ? `${title}, ${sub}. Open to track it` : `${title}. ${sub}`}
        className="w-full min-h-[52px] pl-3 pr-3 py-2 rounded-xl border flex items-center gap-3 text-left cursor-pointer"
        style={{ background: '#17191E', borderColor: active ? 'rgb(var(--bw-accent-rgb)/0.6)' : '#2b2f36' }}
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
