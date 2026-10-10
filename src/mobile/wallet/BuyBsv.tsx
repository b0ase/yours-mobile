import { APP_NAME, SWAP_ENABLED } from '../storeBuild';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useSwapWatcher } from '../swap/useSwapWatcher';
import type { SwapRecord } from '../swap/swapApi';

// Portfolio vs market (owner, 10 Oct 2026): the price tile opens it; its own chunk.
const PortfolioScreen = lazy(() => import('../portfolio/PortfolioScreen'));
// Swap into BSV (bWalletX only): the chunk is dropped from a store build (SWAP_ENABLED).
const SwapFlow = SWAP_ENABLED ? lazy(() => import('../swap/SwapFlow')) : null;
const SwapPromo = SWAP_ENABLED ? lazy(() => import('../swap/SwapPromo')) : null;
import { createPortal } from 'react-dom';
import { ArrowDownToLine, CreditCard, ExternalLink, Users, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { openDappBrowser } from '../dappBrowser';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { HistoryButton } from './HistoryButton';
import { formatUSD } from '../../utils/format';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/** Live BSV price for the bar (re-read every minute while shown). */
const useLivePrice = () => {
  const [rate, setRate] = useState(cachedExchangeRate);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetchExchangeRate('main')
        .then((r) => live && r > 0 && setRate(r))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return rate;
};

/** The whole card is the button: gold, "Buy BSV" with today's price (owner, 6 Oct 2026). */
export const BuyBsvCard = ({
  rate,
  onClick,
  className = '',
}: {
  rate: number;
  onClick: () => void;
  className?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex items-center justify-between gap-2 px-4 py-3 rounded-xl border-0 cursor-pointer ${className}`}
    style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
  >
    <span className="text-base font-extrabold">Buy BSV</span>
    <span className="text-sm font-bold">
      {rate > 0 ? formatUSD(rate) : '…'} <span className="font-semibold opacity-70">per BSV</span>
    </span>
  </button>
);

/** Buy BSV card + its sheet, for screens that don't manage the sheet themselves (e.g. Send BSV with the chart). */
export const BuyBsvButton = ({ onReceive, className }: { onReceive: () => void; className?: string }) => {
  const rate = useLivePrice();
  const [open, setOpen] = useState(false);
  return (
    <>
      <BuyBsvCard rate={rate} onClick={() => setOpen(true)} className={className} />
      {open && (
        <BuyBsvSheet
          onClose={() => setOpen(false)}
          onReceive={() => {
            setOpen(false);
            onReceive();
          }}
        />
      )}
    </>
  );
};

/** The wallet top row's shared cell style: equal columns, same height, radius and border (owner round 7). */
const CELL = 'flex-1 basis-0 min-w-0 h-14 rounded-xl flex items-center justify-center border cursor-pointer';

/**
 * Today's % change of BSV: the live rate against the WhatsOnChain daily rate from about 24 hours ago (the same
 * source as the BSV view's chart). Null until known; read once per app run.
 */
let dayAgoCache: number | null = null;
const useDayChange = (rate: number): number | null => {
  const [dayAgo, setDayAgo] = useState<number | null>(dayAgoCache);
  useEffect(() => {
    if (dayAgoCache) return;
    let live = true;
    const now = Math.floor(Date.now() / 1000);
    fetch(`https://api.whatsonchain.com/v1/bsv/main/exchangerate/historical?from=${now - 3 * 86400}&to=${now}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { rate: number; time: number }[]) => {
        const target = now - 86400;
        const best = rows
          .filter((r) => r.rate > 0)
          .sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target))[0];
        if (best && live) {
          dayAgoCache = best.rate;
          setDayAgo(best.rate);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return dayAgo && rate > 0 ? ((rate - dayAgo) / dayAgo) * 100 : null;
};

/**
 * Today's BSV price; opens the BSV view (price chart), the same as the BSV card below the wallet card. With `change`
 * the small line shows today's % change in green / red instead of "per BSV".
 */
const PriceCell = ({ rate, onOpen, change }: { rate: number; onOpen: () => void; change?: number | null }) => (
  <button
    type="button"
    onClick={onOpen}
    aria-label="BSV price"
    className={`${CELL} flex-col leading-tight`}
    style={{ background: '#17191E', borderColor: '#2b2f36', color: '#fff' }}
  >
    <span className="text-[15px] font-extrabold">{rate > 0 ? formatUSD(rate) : '…'}</span>
    {change == null ? (
      <span className="text-[10px] font-semibold" style={{ color: MUTED }}>
        per BSV
      </span>
    ) : (
      <span className="text-[10px] font-bold" style={{ color: change >= 0 ? '#2ecc71' : '#F04438' }}>
        {change >= 0 ? '+' : ''}
        {change.toFixed(2)}% today
      </span>
    )}
  </button>
);

/** Same box and margins as the promo card, so nothing jumps when the chunk loads. */
const SwapPromoSkeleton = () => <div className="w-[92%] min-h-[52px] -mb-1" aria-hidden="true" />;

/**
 * Wallet top row (owner, rounds 6–7; price restored 10 Oct 2026): price · Buy BSV · History, three equal columns.
 * The price opens the BSV view (`onPrice`, the BSV card's own handler). The "Swap into BSV" promo card below the row
 * is the only swap entry; `getAddress` gives Swap the wallet's own BSV receive address.
 */
export const BsvPriceBar = ({
  onReceive,
  onPrice,
  getAddress,
  bsvSats = 0,
  mneeUsd = 0,
  tokenCount = 0,
}: {
  onReceive: () => void;
  /** Opens the BSV view with its chart (from the Portfolio screen's "BSV chart" button). */
  onPrice: () => void;
  getAddress?: () => Promise<string>;
  /** For Portfolio vs market (the price tile opens it): spendable BSV, MNEE dollars, unpriced tokens. */
  bsvSats?: number;
  mneeUsd?: number;
  tokenCount?: number;
}) => {
  const rate = useLivePrice();
  const change = useDayChange(rate);
  const [open, setOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [resume, setResume] = useState<SwapRecord | null>(null);
  const { addSnackbar } = useSnackbar();
  const { swaps, active } = useSwapWatcher((s) => {
    if (s.stage === 'done') addSnackbar(`Swap finished: ${s.toAmount ?? ''} BSV is in your wallet`, 'success');
    else if (s.stage === 'refunded') addSnackbar('Your swap was refunded', 'info');
    else if (s.stage === 'failed') addSnackbar('A swap needs attention. Open Swap to see it.', 'error');
  });
  const swapOn = SWAP_ENABLED && !!SwapFlow && !!getAddress;
  const openSwap = () => {
    setResume(active[0] ?? (swaps[0] && !swaps[0].notified ? swaps[0] : null));
    setSwapOpen(true);
  };
  return (
    <>
      <div className="w-[92%] mb-2 flex items-stretch gap-2">
        <PriceCell rate={rate} onOpen={() => setPortfolioOpen(true)} change={change} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${CELL} text-sm font-extrabold`}
          style={{
            background: 'linear-gradient(135deg, #de973f, #f9dd63)',
            borderColor: '#f5b80066',
            color: '#1a1300',
          }}
        >
          Buy BSV
        </button>
        <HistoryButton className={CELL} />
      </div>
      {swapOn && SwapPromo && (
        // Equal 8px above and below the promo: the row's mb-2 above; below, the card's own 12px top margin less 4px.
        <Suspense fallback={<SwapPromoSkeleton />}>
          <SwapPromo active={active[0] ?? null} onOpen={openSwap} />
        </Suspense>
      )}
      {!swapOn && <div className="mb-2" />}
      {open && (
        <BuyBsvSheet
          onClose={() => setOpen(false)}
          onReceive={() => {
            setOpen(false);
            onReceive();
          }}
        />
      )}
      {portfolioOpen && (
        <Suspense fallback={null}>
          <PortfolioScreen
            onClose={() => setPortfolioOpen(false)}
            onBsvChart={() => {
              setPortfolioOpen(false);
              onPrice();
            }}
            bsvSats={bsvSats}
            mneeUsd={mneeUsd}
            tokenCount={tokenCount}
            price={rate}
            dayChange={change}
          />
        </Suspense>
      )}
      {swapOn && swapOpen && SwapFlow && getAddress && (
        <Suspense fallback={null}>
          <SwapFlow getAddress={getAddress} resume={resume} onClose={() => setSwapOpen(false)} />
        </Suspense>
      )}
    </>
  );
};

/** Store edition (no Buy BSV): price · History, two equal halves. */
export const BsvHistoryBar = ({ onPrice }: { onPrice: () => void }) => {
  const rate = useLivePrice();
  return (
    <div className="w-[92%] mb-4 flex items-stretch gap-2">
      <PriceCell rate={rate} onOpen={onPrice} />
      <HistoryButton className={CELL} />
    </div>
  );
};

/**
 * Third-party services that sell BSV for card / bank payments (from the BSVRadar list parked on 2 Oct 2026).
 * They run their own checks (KYC) and set their own fees; the wallet only opens them. Buying inside the app with
 * one integrated provider (as HandCash does) is the next step and needs a provider agreement.
 */
const PROVIDERS: { name: string; url: string; desc: string }[] = [
  // Checked 6 Oct 2026 (owner): only these two load a working BSV purchase without a partner key. Ramp is back once
  // our partner key arrives (docs/BUY-BSV-ONRAMP.md). Removed: BSV Association (Onramper test key), Guardarian
  // (BSV page gone, crypto only), Onramper (marketing page), cex.io (no BSV).
  {
    name: 'ChangeNOW',
    url: 'https://changenow.io/currencies/bitcoin-sv?from=usd&to=bsv&fiatMode=true&amount=100',
    desc: 'Card, many currencies',
  },
  {
    name: 'Alchemy Pay',
    url: 'https://ramp.alchemypay.org/?crypto=BCHSV&fiat=USD&network=BCHSV#/index',
    desc: 'Card, Apple Pay, Google Pay',
  },
];

const Row = ({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-3 w-full p-3 rounded-xl text-left border-0 cursor-pointer"
    style={{ background: '#17191E', color: '#fff' }}
  >
    <span style={{ color: GOLD }}>{icon}</span>
    <span className="flex-1 min-w-0">
      <span className="block text-sm font-bold">{title}</span>
      <span className="block text-xs" style={{ color: MUTED }}>
        {sub}
      </span>
    </span>
  </button>
);

export const BuyBsvSheet = ({ onClose, onReceive }: { onClose: () => void; onReceive: () => void }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="flex-1 text-base font-bold text-white">Get BSV</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <Row
          icon={<ArrowDownToLine size={18} />}
          title="From an exchange or another wallet"
          sub="Show your BSV address or QR code to receive"
          onClick={onReceive}
        />
        <Row
          icon={<Users size={18} />}
          title="From a friend"
          sub="Share your $name or paymail and they send it in seconds"
          onClick={onReceive}
        />
        <div className="text-xs font-semibold uppercase tracking-wide mt-1" style={{ color: MUTED }}>
          Buy with a card or bank
        </div>
        {PROVIDERS.map((p) => (
          <Row
            key={p.name}
            icon={<CreditCard size={18} />}
            title={p.name}
            sub={p.desc}
            onClick={() => void openDappBrowser(p.url)}
          />
        ))}
        <p className="m-0 text-[11px] leading-relaxed" style={{ color: MUTED }}>
          These are independent services, not {APP_NAME}. They check your identity and set their own fees and limits.
          Copy your BSV address from Receive and paste it there. <ExternalLink size={10} className="inline" /> Opens in
          the wallet browser.
        </p>
      </div>
    </div>,
    document.body,
  );
};
