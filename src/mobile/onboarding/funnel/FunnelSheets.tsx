import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Copy, Repeat, X } from 'lucide-react';
import { QrCode } from '../../../components/QrCode';
import { cachedExchangeRate, fetchExchangeRate, getWalletBalance } from '../../../utils/wallet';
import { sendMessageAsync } from '../../../utils/chromeHelpers';
import { YoursEventName } from '../../../inject';
import { SWAP_ENABLED } from '../../storeBuild';
import { logStep, satsToUsd, usdLabel, type FunnelProduct } from './funnel';

/**
 * The funnel's two sheets (funnel.ts): "Get bWalletX" after the free taste, and "Add a little BSV" before the first
 * paid thing. Gold on black. Only what works today: swap other crypto into BSV, or receive to the wallet's address.
 * No card on-ramp until one is live (Ramp is pending), so no card row and no "coming soon".
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#0b0b0d';
const LINE = '#3a2f12';
const MUTED = '#c9b98a';
const SwapFlow = SWAP_ENABLED ? lazy(() => import('../../swap/SwapFlow')) : null;

const Sheet = ({ onClose, children }: { onClose: () => void; children: React.ReactNode }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[1100] flex items-end md:items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.75)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-[440px] p-5 flex flex-col gap-4 rounded-t-2xl md:rounded-2xl"
        style={{
          background: `radial-gradient(120% 80% at 50% 0%, rgb(var(--bw-accent-hi-rgb) / 0.14), ${PANEL} 60%)`,
          border: `1px solid ${LINE}`,
          paddingBottom: 'max(env(safe-area-inset-bottom), 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="Close" onClick={onClose} className="self-end -mb-3 p-1">
          <X size={18} color={MUTED} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );

const Gold = ({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="w-full py-3 rounded-full text-base font-extrabold"
    style={{
      background: 'linear-gradient(135deg, var(--bw-accent-lo), var(--bw-accent-hi))',
      color: 'var(--bw-on-accent)',
      opacity: disabled ? 0.6 : 1,
    }}
  >
    {children}
  </button>
);

/** After the free taste: create (or unlock) a wallet for the sponsored tracks. */
export const GetWalletSheet = ({
  product,
  onCreate,
  onClose,
}: {
  product: FunnelProduct;
  onCreate: () => void;
  onClose: () => void;
}) => {
  useEffect(() => logStep(product.id, 'wallet'), [product.id]);
  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] font-bold uppercase tracking-[.18em]" style={{ color: GOLD }}>
        {product.wallet.kicker}
      </div>
      <h3 className="text-2xl font-black text-white -mt-2">{product.wallet.title}</h3>
      <p className="text-sm -mt-1" style={{ color: MUTED }}>
        {product.wallet.body}
      </p>
      <Gold onClick={onCreate}>{product.wallet.cta}</Gold>
      <button type="button" onClick={onClose} className="text-sm" style={{ color: MUTED }}>
        Not now
      </button>
    </Sheet>
  );
};

/** The wallet's own BSV receive address ('' if the wallet doesn't answer). */
const receiveAddress = async (): Promise<string> => {
  try {
    const r = await Promise.race([
      sendMessageAsync<{ success: boolean; data?: string }>({ action: YoursEventName.GET_RECEIVE_ADDRESS }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return r?.success && r.data ? r.data : '';
  } catch {
    return '';
  }
};

/**
 * Before the first paid thing with too little BSV: swap or receive, with the cost of the rest (`neededSats`) in
 * dollars. Polls the balance; once it covers `enoughSats` (the least worth going on with), `onFunded` resumes.
 */
export const AddFundsSheet = ({
  product,
  neededSats,
  enoughSats = neededSats,
  onFunded,
  onClose,
}: {
  product: FunnelProduct;
  neededSats: number;
  enoughSats?: number;
  onFunded: () => void;
  onClose: () => void;
}) => {
  const funded = useRef(onFunded);
  funded.current = onFunded;
  const [rate, setRate] = useState(cachedExchangeRate);
  const [mode, setMode] = useState<'pick' | 'receive' | 'swap'>('pick');
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => logStep(product.id, 'funds'), [product.id]);
  useEffect(() => {
    void fetchExchangeRate('main')
      .then((r) => r > 0 && setRate(r))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    let live = true;
    const check = () =>
      getWalletBalance()
        .then((b) => live && b >= enoughSats && funded.current())
        .catch(() => undefined);
    const t = setInterval(check, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [enoughSats]);
  useEffect(() => {
    if (mode === 'receive' && address === null) void receiveAddress().then(setAddress);
  }, [mode, address]);

  const cost = usdLabel(satsToUsd(neededSats, rate)) || `${neededSats.toLocaleString()} sats`;
  if (mode === 'swap' && SwapFlow)
    return (
      <Suspense fallback={null}>
        <SwapFlow getAddress={receiveAddress} onClose={() => setMode('pick')} />
      </Suspense>
    );
  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] font-bold uppercase tracking-[.18em]" style={{ color: GOLD }}>
        Keep listening
      </div>
      <h3 className="text-2xl font-black text-white -mt-2">{product.funds.title}</h3>
      <p className="text-sm -mt-1" style={{ color: MUTED }}>
        {product.funds.body.replace('{cost}', cost)}
      </p>
      {mode === 'pick' ? (
        <div className="flex flex-col gap-2">
          {SwapFlow && (
            <Row
              icon={<Repeat size={18} />}
              title="Swap other crypto into BSV"
              sub="BTC, ETH, USDT and more, inside the wallet"
              onClick={() => setMode('swap')}
            />
          )}
          <Row
            icon={<ArrowDownToLine size={18} />}
            title="Receive BSV"
            sub="From an exchange, another wallet or a friend"
            onClick={() => setMode('receive')}
          />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {address ? (
            <>
              <QrCode address={address} />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(address).then(() => setCopied(true));
                }}
                className="flex items-center gap-2 text-xs break-all text-left"
                style={{ color: GOLD }}
              >
                <Copy size={14} className="shrink-0" /> {copied ? 'Copied' : address}
              </button>
            </>
          ) : (
            <div className="text-sm" style={{ color: MUTED }}>
              {address === '' ? "Couldn't read your address. Open Receive in the wallet." : 'Getting your address…'}
            </div>
          )}
          <button type="button" onClick={() => setMode('pick')} className="text-sm" style={{ color: MUTED }}>
            Back
          </button>
        </div>
      )}
      <p className="text-xs text-center" style={{ color: MUTED }}>
        {product.funds.after}
      </p>
    </Sheet>
  );
};

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
    className="flex items-center gap-3 w-full p-3 rounded-xl text-left"
    style={{ background: 'rgb(var(--bw-accent-hi-rgb) / 0.06)', border: `1px solid ${LINE}`, color: '#fff' }}
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
