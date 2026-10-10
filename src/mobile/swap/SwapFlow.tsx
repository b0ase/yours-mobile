import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import * as qr from 'qrcode';
import { ArrowDown, Check, ChevronDown, ChevronLeft, Copy, Loader2, Search, X } from 'lucide-react';
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
  coinTileText,
  safeCoinImage,
  withImages,
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
import { pickGate, type AddressState } from './pickGate';

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

// ── Coin icon (lazy logo, letter circle if it fails) ──
const CoinIcon = ({ coin, size = 40 }: { coin: SwapCoin; size?: number }) => {
  const src = safeCoinImage(coin.image);
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  const t = coinTileText(coin).ticker;
  if (!src || bad)
    return (
      <span
        aria-hidden="true"
        className="rounded-full grid place-items-center font-bold shrink-0"
        style={{ width: size, height: size, background: C.chip, color: C.text, fontSize: Math.round(size * 0.42) }}
      >
        {t.charAt(0)}
      </span>
    );
  return (
    <img
      src={src}
      alt={`${t} logo`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      width={size}
      height={size}
      onError={() => setBad(true)}
      className="rounded-full shrink-0 object-contain"
      style={{ width: size, height: size, background: '#fff' }}
    />
  );
};

// ── Coin menu (drop-down from the "You send" button: popover on wide screens, bottom sheet on phones) ──
const coinKey = (c: SwapCoin) => `${c.ticker}:${c.network}`;
const coinMatches = (c: SwapCoin, q: string) => {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [c.ticker, c.network, c.label, c.name ?? '', networkName(c)].some((x) => x.toLowerCase().includes(t));
};

const CoinMenu = ({
  popular,
  all,
  current,
  onPick,
  onClose,
}: {
  popular: SwapCoin[];
  all: SwapCoin[];
  current: SwapCoin;
  onPick: (c: SwapCoin) => void;
  onClose: () => void;
}) => {
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<SwapCoin[]>([]);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) return setRemote([]);
    const t = setTimeout(() => {
      api
        .currencies(q.trim())
        .then((r) => setRemote(Array.isArray(r.currencies) ? r.currencies : []))
        .catch(() => setRemote([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: { coin: SwapCoin; popular: boolean }[] = [];
    const add = (c: SwapCoin, p: boolean) => {
      const k = coinKey(c);
      if (seen.has(k) || !coinMatches(c, q)) return;
      seen.add(k);
      out.push({ coin: c, popular: p });
    };
    popular.forEach((c) => add(c, true));
    all.forEach((c) => add(c, false));
    remote.forEach((c) => {
      const k = coinKey(c);
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ coin: c, popular: false });
      }
    });
    return out.slice(0, 300);
  }, [popular, all, remote, q]);
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' && items[hi]) {
      e.preventDefault();
      onPick(items[hi].coin);
    }
  };
  const firstOther = items.findIndex((i) => !i.popular);

  return (
    <>
      <div className="fixed inset-0 z-20 sm:bg-transparent" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose the coin you send"
        onKeyDown={onKey}
        className="fixed z-30 inset-x-0 bottom-0 max-h-[75vh] rounded-t-2xl sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[340px] sm:max-h-[420px] sm:rounded-2xl flex flex-col shadow-2xl"
        style={{ background: C.card, border: `1px solid ${C.line}`, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="p-3 flex items-center gap-2">
          <label className="flex-1 flex items-center gap-2 h-11 px-3 rounded-xl" style={{ border: `1px solid ${C.chip}`, background: C.bg }}>
            <Search size={16} color={C.muted} />
            <span className="sr-only">Search coins</span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search coins"
              role="combobox"
              aria-expanded="true"
              aria-controls="swap-coin-list"
              aria-activedescendant={items[hi] ? `swap-coin-${hi}` : undefined}
              className="flex-1 min-w-0 border-0 bg-transparent outline-none text-sm"
              style={{ color: C.text }}
            />
          </label>
          <button type="button" aria-label="Close coin list" onClick={onClose} className="w-11 h-11 grid place-items-center border-0 bg-transparent cursor-pointer">
            <X size={18} color={C.muted} />
          </button>
        </div>
        <ul ref={listRef} id="swap-coin-list" role="listbox" aria-label="Coins" className="m-0 p-0 pb-2 list-none overflow-y-auto flex-1">
          {items.length === 0 && (
            <li className="px-4 py-3 text-sm" style={{ color: C.muted }}>
              No coins match “{q}”
            </li>
          )}
          {items.map(({ coin: c, popular: p }, i) => {
            const { ticker } = coinTileText(c);
            const on = coinKey(c) === coinKey(current);
            return (
              <li key={coinKey(c)} role="presentation">
                {i === 0 && p && (
                  <div className="px-4 pt-1 pb-1 text-[11px] uppercase tracking-[0.1em]" style={{ color: C.gold }}>
                    Popular
                  </div>
                )}
                {i === firstOther && (
                  <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-[0.1em]" style={{ color: C.gold }}>
                    All coins
                  </div>
                )}
                <div
                  id={`swap-coin-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={on}
                  tabIndex={-1}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => onPick(c)}
                  className="mx-2 px-2 min-h-[48px] flex items-center gap-3 rounded-xl cursor-pointer"
                  style={{ background: i === hi ? C.cardHi : 'transparent' }}
                >
                  <CoinIcon coin={c} size={28} />
                  <span className="flex-1 min-w-0 flex flex-col leading-tight">
                    <span className="text-sm font-bold" style={{ color: on ? C.gold : C.text }}>
                      {ticker}
                      {c.name && (
                        <span className="ml-1.5 font-normal" style={{ color: C.muted }}>
                          {c.name}
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] truncate" style={{ color: C.muted }}>
                      {networkName(c)}
                    </span>
                  </span>
                  {on && <Check size={16} color={C.gold} aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
};

// ── Pick ────────────────────────────────────────────────────────────────────────────────────
const Pick = ({
  address,
  addressState,
  onRetryAddress,
  notice,
  onBack,
  onCreated,
  handle,
  popular,
  all,
}: {
  address: string;
  addressState: AddressState;
  onRetryAddress: () => void;
  notice: SwapNotice;
  popular: SwapCoin[];
  all: SwapCoin[];
  onBack: () => void;
  onCreated: (r: SwapRecord) => void;
  handle?: string;
}) => {
  const [coin, setCoin] = useState<SwapCoin>(POPULAR_COINS[0]);
  const [amount, setAmount] = useState('');
  const [refund, setRefund] = useState('');
  const [est, setEst] = useState<{ toAmount: number | null; minAmount: number; belowMin?: boolean; warning?: string | null } | null>(null);
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState(false);
  const coinBtn = useRef<HTMLButtonElement>(null);
  const n = parseTyped(amount);
  // Show the server's images on the picked coin once they arrive.
  const shown = useMemo(() => popular.concat(all).find((c) => coinKey(c) === coinKey(coin) && c.image) ?? coin, [coin, popular, all]);

  // Quote: asked for the minimum as soon as a coin is picked (amount 0), then for the typed amount.
  useEffect(() => {
    let live = true;
    setEstError('');
    setEstLoading(true);
    const t = setTimeout(() => {
      api
        .estimate(coin, n ?? 0)
        .then((r) => live && setEst(r))
        .catch((e: Error) => live && (setEst(null), setEstError(e.message)))
        .finally(() => live && setEstLoading(false));
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [coin, n]);

  const gate = pickGate({
    amount: n,
    typed: amount,
    addressState,
    est: n !== null && !estLoading ? est : null,
    estError,
    estLoading: estLoading || (n !== null && !est),
    busy,
    ticker: coin.ticker,
    fmt: (x) => fmtAmount(x),
  });
  const go = async () => {
    if (!gate.ok || n === null) return;
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
  const below = !!est && n !== null && (est.belowMin || n < est.minAmount);
  const closeMenu = () => {
    setMenu(false);
    coinBtn.current?.focus();
  };

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
            <div className="relative">
              <button
                ref={coinBtn}
                type="button"
                onClick={() => setMenu((m) => !m)}
                aria-haspopup="dialog"
                aria-expanded={menu}
                aria-label={`You send ${coin.ticker.toUpperCase()} on ${networkName(coin)}. Change coin`}
                className="h-11 pl-1.5 pr-2.5 rounded-full flex items-center gap-2 text-sm font-bold whitespace-nowrap cursor-pointer bg-transparent"
                style={{ border: `1px solid ${menu ? C.gold : C.chip}`, color: C.text }}
              >
                <CoinIcon coin={shown} size={30} />
                {coinTileText(coin).ticker}
                <span className="text-xs font-normal" style={{ color: C.muted }}>
                  {networkName(coin)}
                </span>
                <ChevronDown size={16} color={C.muted} aria-hidden="true" />
              </button>
              {menu && (
                <CoinMenu
                  popular={popular}
                  all={all}
                  current={coin}
                  onClose={closeMenu}
                  onPick={(c) => {
                    setCoin(c);
                    closeMenu();
                  }}
                />
              )}
            </div>
          </div>
          <div className="text-xs" style={{ color: below ? '#ff8a7a' : C.muted }}>
            {est ? `Minimum ${fmtAmount(est.minAmount)} ${coin.ticker.toUpperCase()}` : estError ? 'Minimum unavailable' : '…'}
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
              ≈ {n !== null && est?.toAmount ? fmtAmount(est.toAmount, 4) : '…'} BSV
            </span>
            {usd && n !== null && (
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

        <label className="mx-4 mt-4 flex flex-col gap-1 text-xs" style={{ color: C.muted }}>
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
        <Cta onClick={() => void go()} disabled={!gate.ok}>
          {busy ? <Loader2 className="inline animate-spin" size={18} /> : 'Get deposit address'}
        </Cta>
        {!gate.ok && !busy && (
          <p role="status" aria-live="polite" className="m-0 mt-2 text-[12px] text-center" style={{ color: gate.retryAddress ? '#ff8a7a' : C.muted }}>
            {gate.reason}
            {gate.retryAddress && (
              <>
                {' '}
                <button type="button" onClick={onRetryAddress} className="p-0 border-0 bg-transparent underline cursor-pointer text-[12px]" style={{ color: C.gold }}>
                  Try again
                </button>
              </>
            )}
          </p>
        )}
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
  const [addressState, setAddressState] = useState<AddressState>('loading');
  const [all, setAll] = useState<SwapCoin[]>([]);
  const [notice, setNotice] = useState<SwapNotice>(FALLBACK_NOTICE);
  const [popular, setPopular] = useState<SwapCoin[]>(POPULAR_COINS);
  const [swap, setSwap] = useState<SwapRecord | null>(resume ?? null);
  const [step, setStep] = useState<'pick' | 'deposit' | 'track'>(resume ? 'track' : 'pick');
  useBackClose(true, onClose);

  /** The wallet's BSV address for the payout; a failure is shown under the button with "Try again". */
  const loadAddress = useCallback(() => {
    setAddressState('loading');
    getAddress()
      .then((a) => {
        setAddress(a);
        setAddressState(a ? 'ok' : 'error');
      })
      .catch(() => setAddressState('error'));
  }, [getAddress]);

  useEffect(() => {
    if (resume) return;
    loadAddress();
    api
      .currencies()
      .then((r) => {
        if (r.notice) setNotice(r.notice);
        if (Array.isArray(r.currencies)) {
          setPopular((p) => withImages(p, r.currencies));
          setAll(r.currencies);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = useMemo(() => {
    if (step === 'pick' || !swap)
      return (
        <Pick
          address={address}
          addressState={addressState}
          onRetryAddress={loadAddress}
          notice={notice}
          popular={popular}
          all={all}
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
  }, [step, swap, address, addressState, loadAddress, notice, popular, all, handle, onClose]);

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
