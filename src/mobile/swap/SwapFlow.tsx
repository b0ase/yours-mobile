import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import * as qr from 'qrcode';
import { ArrowDown, Check, ChevronLeft, Copy, Loader2, Search, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { openDappBrowser } from '../dappBrowser';
import { useOnResume } from '../permissions/useOnResume';
import { cachedExchangeRate } from '../../utils/wallet';
import { formatUSD } from '../../utils/format';
import {
  applyStatus,
  FALLBACK_NOTICE,
  FINAL,
  fmtAmount,
  networkName,
  parseTyped,
  POLL_MS,
  POPULAR_COINS,
  saveSwap,
  shortAddr,
  stepIndex,
  STEPS,
  SwapApi,
  type SwapCoin,
  type SwapNotice,
  type SwapRecord,
} from './swapApi';

/** Black / gold, as the approved design (bWalletX palette). */
const C = {
  bg: '#0B0A08',
  card: '#17140E',
  cardHi: '#1E190F',
  line: '#2A251B',
  chip: '#4A3F25',
  text: '#F1EAD9',
  muted: '#A39A85',
  gold: '#E9B52A',
  cta: '#FFD24D',
};

const api = new SwapApi();

const Notice = ({ notice }: { notice: SwapNotice }) => (
  <p className="m-0 px-5 pb-4 text-[11px] leading-relaxed text-center" style={{ color: C.muted }}>
    {notice.text}{' '}
    {notice.links.map((l, i) => (
      <span key={l.url}>
        {i > 0 && ' · '}
        <button
          type="button"
          onClick={() => void openDappBrowser(l.url)}
          className="p-0 border-0 bg-transparent underline cursor-pointer text-[11px]"
          style={{ color: C.gold }}
        >
          {l.label}
        </button>
      </span>
    ))}
  </p>
);

const Header = ({ title, back, onBack }: { title: string; back: string; onBack: () => void }) => (
  <>
    <div className="flex items-center gap-2 px-3 pt-4 pb-1">
      <button
        type="button"
        aria-label={`Back to ${back}`}
        onClick={onBack}
        className="w-11 h-11 grid place-items-center border-0 bg-transparent cursor-pointer"
      >
        <ChevronLeft size={22} color={C.text} />
      </button>
      <span className="text-[15px]" style={{ color: C.muted }}>
        {back}
      </span>
    </div>
    <h1 className="mx-5 mt-1 mb-3 text-[28px] font-bold" style={{ color: C.text }}>
      {title}
    </h1>
  </>
);

const Cta = ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="w-full h-[52px] rounded-2xl border-0 text-base font-bold cursor-pointer disabled:opacity-50"
    style={{ background: C.cta, color: C.bg }}
  >
    {children}
  </button>
);

const CopyRow = ({ label, value }: { label: string; value: string }) => {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: C.card, border: `1px solid ${C.line}` }}>
      <div className="flex-1 min-w-0">
        <div className="text-[11px]" style={{ color: C.muted }}>
          {label}
        </div>
        <div className="text-sm font-semibold break-all" style={{ color: C.text }}>
          {value}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="h-11 px-3 rounded-xl border-0 flex items-center gap-1 text-sm font-bold cursor-pointer"
        style={{ background: C.chip, color: C.text }}
      >
        {done ? <Check size={16} /> : <Copy size={16} />} {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
};

// ── Pick ────────────────────────────────────────────────────────────────────────────────────
const Pick = ({
  address,
  notice,
  onBack,
  onCreated,
  handle,
}: {
  address: string;
  notice: SwapNotice;
  onBack: () => void;
  onCreated: (r: SwapRecord) => void;
  handle?: string;
}) => {
  const [coin, setCoin] = useState<SwapCoin>(POPULAR_COINS[0]);
  const [amount, setAmount] = useState('');
  const [refund, setRefund] = useState('');
  const [est, setEst] = useState<{ toAmount: number | null; minAmount: number; belowMin?: boolean; warning?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SwapCoin[]>([]);
  const n = parseTyped(amount);

  useEffect(() => {
    setEst(null);
    setErr('');
    const t = setTimeout(() => {
      api
        .estimate(coin, n ?? 0)
        .then(setEst)
        .catch((e: Error) => setErr(e.message));
    }, 450);
    return () => clearTimeout(t);
  }, [coin, n]);

  useEffect(() => {
    if (search.trim().length < 2) return setResults([]);
    const t = setTimeout(() => {
      api
        .currencies(search.trim())
        .then((r) => setResults(r.currencies.slice(0, 12)))
        .catch(() => setResults([]));
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const canGo = !!address && n !== null && !!est && !est.belowMin && est.toAmount !== null && !busy;
  const go = async () => {
    if (!canGo || n === null) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.create(coin, n, address, refund.trim() || undefined, handle);
      const rec: SwapRecord = {
        id: r.id,
        createdAt: Date.now(),
        from: coin.ticker,
        network: coin.network,
        label: coin.label,
        amount: r.fromAmount || n,
        toAmount: r.toAmount ?? est?.toAmount ?? null,
        payinAddress: r.payinAddress,
        payinExtraId: r.payinExtraId,
        address,
        stage: 'waiting',
        payoutTxid: null,
        validUntil: null,
      };
      saveSwap(rec);
      onCreated(rec);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rate = cachedExchangeRate();
  const usd = est?.toAmount && rate > 0 ? formatUSD(est.toAmount * rate) : null;
  const chipOn = (c: SwapCoin) => c.ticker === coin.ticker && c.network === coin.network;

  return (
    <>
      <Header title="Swap into BSV" back="Wallet" onBack={onBack} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-4 rounded-2xl p-3.5 flex flex-col gap-2.5" style={{ background: C.card, border: `1px solid ${C.line}` }}>
          <div className="text-xs" style={{ color: C.muted }}>
            You send
          </div>
          <div className="flex gap-2.5 items-center">
            <label className="flex-1 min-w-0">
              <span className="sr-only">Amount to send</span>
              <input
                inputMode="decimal"
                value={amount}
                placeholder="0.00"
                onChange={(e) => setAmount(e.target.value)}
                className="w-full h-12 border-0 bg-transparent text-[30px] font-bold outline-none"
                style={{ color: C.text }}
              />
            </label>
            <span className="h-11 px-3 rounded-full grid place-items-center text-sm font-bold whitespace-nowrap" style={{ border: `1px solid ${C.chip}`, color: C.text }}>
              {coin.ticker.toUpperCase()} · {networkName(coin)}
            </span>
          </div>
          <div className="text-xs" style={{ color: est?.belowMin ? '#ff8a7a' : C.muted }}>
            {est ? `Minimum ${fmtAmount(est.minAmount)} ${coin.ticker.toUpperCase()}` : '…'}
          </div>
        </div>
        <div className="grid place-items-center h-9">
          <ArrowDown size={22} color={C.gold} />
        </div>
        <div className="mx-4 rounded-2xl p-3.5 flex flex-col gap-1.5" style={{ background: C.cardHi, border: `1px solid ${C.gold}` }}>
          <div className="text-xs" style={{ color: C.muted }}>
            You get, in this wallet
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-[30px] font-bold" style={{ color: C.text }}>
              ≈ {est?.toAmount ? fmtAmount(est.toAmount, 4) : '…'} BSV
            </span>
            {usd && (
              <span className="text-sm" style={{ color: C.muted }}>
                {usd}
              </span>
            )}
          </div>
          <div className="text-xs" style={{ color: C.muted }}>
            To {address ? shortAddr(address) : '…'} (your wallet). Fees included, rate floats.
          </div>
          {est?.warning && (
            <div className="text-xs" style={{ color: C.gold }}>
              {est.warning}
            </div>
          )}
        </div>

        <div className="mx-4 mt-4 text-xs uppercase tracking-[0.1em]" style={{ color: C.gold }}>
          Popular
        </div>
        <div className="mx-4 mt-2 flex flex-wrap gap-2">
          {POPULAR_COINS.map((c) => (
            <button
              key={`${c.ticker}-${c.network}`}
              type="button"
              onClick={() => setCoin(c)}
              className="px-3 py-2 rounded-full text-[13px] cursor-pointer"
              style={
                chipOn(c)
                  ? { background: C.gold, color: C.bg, fontWeight: 700, border: 0 }
                  : { background: 'transparent', color: C.text, border: `1px solid ${C.chip}` }
              }
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="mx-4 mt-3 flex items-center gap-2 h-11 px-3 rounded-xl" style={{ border: `1px solid ${C.chip}`, background: C.bg }}>
          <Search size={16} color={C.muted} />
          <span className="sr-only">Search coins</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search other coins"
            className="flex-1 min-w-0 border-0 bg-transparent outline-none text-sm"
            style={{ color: C.text }}
          />
        </label>
        {results.length > 0 && (
          <div className="mx-4 mt-2 flex flex-wrap gap-2">
            {results.map((c) => (
              <button
                key={`${c.ticker}-${c.network}`}
                type="button"
                onClick={() => {
                  setCoin(c);
                  setSearch('');
                }}
                className="px-3 py-2 rounded-full text-[13px] cursor-pointer"
                style={{ background: 'transparent', color: C.text, border: `1px solid ${C.chip}` }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <label className="mx-4 mt-3.5 flex flex-col gap-1 text-xs" style={{ color: C.muted }}>
          Refund address ({coin.ticker.toUpperCase()}), optional, used if the swap can’t finish
          <input
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            placeholder={`Your ${networkName(coin)} address`}
            className="h-11 rounded-xl px-3 text-sm outline-none"
            style={{ border: `1px solid ${C.chip}`, background: C.bg, color: C.text }}
          />
        </label>
        {err && (
          <div className="mx-4 mt-3 text-sm" style={{ color: '#ff8a7a' }}>
            {err}
          </div>
        )}
      </div>
      <div className="px-4 pt-3 pb-2">
        <Cta onClick={() => void go()} disabled={!canGo}>
          {busy ? <Loader2 className="inline animate-spin" size={18} /> : 'Get deposit address'}
        </Cta>
      </div>
      <Notice notice={notice} />
    </>
  );
};

// ── Deposit ─────────────────────────────────────────────────────────────────────────────────
const Deposit = ({ swap, notice, onBack, onSent }: { swap: SwapRecord; notice: SwapNotice; onBack: () => void; onSent: () => void }) => {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  useEffect(() => {
    qr.toDataURL(swap.payinAddress, { margin: 2, width: 220, color: { dark: '#000000', light: '#ffffff' } }, (e, url) => !e && setQrUrl(url));
  }, [swap.payinAddress]);
  const tick = swap.from.toUpperCase();
  const net = networkName({ ticker: swap.from, network: swap.network });
  const expires = swap.validUntil ? new Date(swap.validUntil) : null;
  return (
    <>
      <Header title={`Send ${tick}`} back="Swap" onBack={onBack} />
      <div className="flex-1 overflow-y-auto px-4 flex flex-col gap-3">
        <div className="rounded-2xl p-3.5" style={{ background: C.cardHi, border: `1px solid ${C.gold}` }}>
          <div className="text-xs" style={{ color: C.muted }}>
            Send exactly
          </div>
          <div className="text-[28px] font-bold" style={{ color: C.text }}>
            {fmtAmount(swap.amount)} {tick}
          </div>
          <div className="text-xs" style={{ color: C.muted }}>
            You get ≈ {fmtAmount(swap.toAmount, 4)} BSV in this wallet
          </div>
        </div>
        {qrUrl && (
          <div className="self-center p-2 rounded-xl" style={{ background: '#fff' }}>
            <img src={qrUrl} alt={`QR code for the ${tick} deposit address`} width={200} height={200} />
          </div>
        )}
        <CopyRow label={`${tick} deposit address (${net})`} value={swap.payinAddress} />
        {swap.payinExtraId && <CopyRow label="Memo / tag (required)" value={swap.payinExtraId} />}
        <CopyRow label="Amount" value={String(fmtAmount(swap.amount))} />
        <div className="rounded-xl p-3 text-[13px] leading-snug" style={{ background: '#2a1d0b', color: C.cta, border: `1px solid ${C.chip}` }}>
          Send only {tick} on the {net} network to this address. Other coins or networks can be lost.
          {expires ? ` Send before ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : ' Send within the next few hours; the rate floats until it arrives.'}
        </div>
      </div>
      <div className="px-4 pt-3 pb-2">
        <Cta onClick={onSent}>I’ve sent it</Cta>
      </div>
      <Notice notice={notice} />
    </>
  );
};

// ── Track ───────────────────────────────────────────────────────────────────────────────────
const Track = ({ swap, onBack, onUpdate }: { swap: SwapRecord; onBack: () => void; onUpdate: (r: SwapRecord) => void }) => {
  const navigate = useNavigate();
  const ref = useRef(swap);
  ref.current = swap;
  const poll = useCallback(() => {
    if (FINAL.has(ref.current.stage)) return;
    api
      .status(ref.current.id)
      .then((s) => {
        const next = applyStatus(ref.current, s);
        saveSwap(next);
        onUpdate(next);
      })
      .catch(() => undefined);
  }, [onUpdate]);
  useEffect(() => {
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);
  useOnResume(poll);

  const at = stepIndex(swap.stage);
  const tick = swap.from.toUpperCase();
  const end =
    swap.stage === 'refunded'
      ? 'Refunded to your refund address.'
      : swap.stage === 'failed'
        ? 'This swap didn’t finish. Ask b for help with the swap id below.'
        : swap.stage === 'expired'
          ? 'No deposit arrived in time, so this swap expired. Start a new one.'
          : swap.stage === 'on_hold'
            ? 'ChangeNOW is checking this swap (AML/KYC). They may email or ask for details.'
            : swap.stage === 'waiting'
              ? `Waiting for your ${tick}. This page checks every 20 seconds.`
              : null;
  return (
    <>
      <Header title="Swap on its way" back="Wallet" onBack={onBack} />
      <div className="flex-1 overflow-y-auto px-4 flex flex-col gap-3">
        <div className="text-sm" style={{ color: C.muted }}>
          {fmtAmount(swap.amount)} {tick} → ≈ {fmtAmount(swap.toAmount, 4)} BSV
        </div>
        <ol className="m-0 p-0 list-none flex flex-col gap-0">
          {STEPS.map((label, i) => {
            const done = i <= at;
            const now = i === at + 1 && !FINAL.has(swap.stage);
            return (
              <li key={label} className="flex items-center gap-3 py-3" style={{ borderBottom: `1px solid ${C.line}` }}>
                <span
                  className="w-7 h-7 rounded-full grid place-items-center"
                  style={{ background: done ? C.gold : 'transparent', border: `2px solid ${done || now ? C.gold : C.chip}` }}
                >
                  {done ? <Check size={16} color={C.bg} /> : now ? <Loader2 size={14} color={C.gold} className="animate-spin" /> : null}
                </span>
                <span className="text-[15px] font-semibold" style={{ color: done || now ? C.text : C.muted }}>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
        {end && (
          <div className="text-sm" style={{ color: C.text }}>
            {end}
          </div>
        )}
        {swap.stage !== 'done' && (
          <div className="text-xs" style={{ color: C.muted }}>
            We’ll let you know when the BSV lands. You can close this; it keeps going.
          </div>
        )}
        {swap.payoutTxid && <CopyRow label="BSV transaction" value={swap.payoutTxid} />}
        <CopyRow label="Swap id (ChangeNOW)" value={swap.id} />
      </div>
      <div className="px-4 pt-3 pb-4 flex flex-col gap-2">
        {swap.stage === 'done' ? <Cta onClick={onBack}>Back to wallet</Cta> : null}
        <button
          type="button"
          onClick={() => navigate('/m/agent')}
          className="w-full h-12 rounded-2xl text-[15px] font-bold cursor-pointer bg-transparent"
          style={{ border: `1px solid ${C.chip}`, color: C.text }}
        >
          Ask b for help
        </button>
      </div>
    </>
  );
};

// ── Flow ────────────────────────────────────────────────────────────────────────────────────
/**
 * The swap screens (Pick → Deposit → Track) as one full-screen layer. `getAddress` returns the wallet's receive
 * address (a fresh deposit address where the wallet can make one). `resume` opens an existing swap on Track.
 */
export const SwapFlow = ({
  getAddress,
  onClose,
  resume,
  handle,
}: {
  getAddress: () => Promise<string>;
  onClose: () => void;
  resume?: SwapRecord | null;
  handle?: string;
}) => {
  const [address, setAddress] = useState('');
  const [notice, setNotice] = useState<SwapNotice>(FALLBACK_NOTICE);
  const [swap, setSwap] = useState<SwapRecord | null>(resume ?? null);
  const [step, setStep] = useState<'pick' | 'deposit' | 'track'>(resume ? 'track' : 'pick');
  useBackClose(true, onClose);

  useEffect(() => {
    if (resume) return;
    getAddress()
      .then(setAddress)
      .catch(() => undefined);
    api
      .currencies()
      .then((r) => r.notice && setNotice(r.notice))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = useMemo(() => {
    if (step === 'pick' || !swap)
      return (
        <Pick
          address={address}
          notice={notice}
          handle={handle}
          onBack={onClose}
          onCreated={(r) => {
            setSwap(r);
            setStep('deposit');
          }}
        />
      );
    if (step === 'deposit') return <Deposit swap={swap} notice={notice} onBack={() => setStep('pick')} onSent={() => setStep('track')} />;
    return <Track swap={swap} onBack={onClose} onUpdate={setSwap} />;
  }, [step, swap, address, notice, handle, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex justify-center"
      style={{ background: C.bg, paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="relative w-full max-w-[480px] h-full flex flex-col" style={{ color: C.text }}>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-4 w-11 h-11 grid place-items-center border-0 bg-transparent cursor-pointer z-10"
        >
          <X size={20} color={C.muted} />
        </button>
        {body}
      </div>
    </div>,
    document.body,
  );
};

export default SwapFlow;
