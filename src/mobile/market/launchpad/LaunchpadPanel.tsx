/**
 * Market › Tokens › Launchpad: BlastPad coins (tokenblaster.lol's BSV-21 bonding-curve launchpad),
 * bought and sold on each coin's curve from the active account's own wallet (client.ts trade()).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getBsv21Balances } from '@1sat/actions';
import { Coins, X } from 'lucide-react';
import { useBackClose } from '../../backStack';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { money, useBsvUsd } from '../../money/money';
import { openDappBrowser } from '../../dappBrowser';
import { big, change24, coinImage, coinPage, fetchCoin, fetchCoins, sortBoard, wocTx, type BoardCoin } from './api';
import {
  HOUSE_BPS,
  MAX_BUY,
  MIN_BUY,
  ROUTE_BPS,
  exactBsv,
  exactTokens,
  fmtSats,
  fmtTokens,
  marketCap,
  poolSats,
  price,
  progress,
  quoteBuy,
  quoteSell,
} from './curve';
import { trade } from './client';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const GOLD = '#FFD24D';
const LINE = '#2b2f36';
const FEE_PCT = `${(Number(HOUSE_BPS + ROUTE_BPS) / 100).toFixed(1)}%`;

const CoinArt = ({ id, size = 40 }: { id: string; size?: number }) => {
  const [bad, setBad] = useState(false);
  return bad ? (
    <div
      className="rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <Coins size={16} color="#98A2B3" />
    </div>
  ) : (
    <img
      src={coinImage(id)}
      alt=""
      loading="lazy"
      onError={() => setBad(true)}
      className="rounded-lg object-cover shrink-0 bg-[#2b2f36]"
      style={{ width: size, height: size }}
    />
  );
};

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const Bar = ({ p }: { p: number }) => (
  <div className="h-1 w-full rounded-full bg-[#2b2f36] overflow-hidden">
    <div className="h-full rounded-full" style={{ width: `${Math.round(p * 100)}%`, background: '#A1FF8B' }} />
  </div>
);
const GradBadge = () => (
  <span className="rounded-full px-1.5 py-[1px] text-[9px] font-bold" style={{ background: '#2a2208', color: GOLD }}>
    GRAD
  </span>
);

export const LaunchpadPanel = () => {
  const rate = useBsvUsd();
  const [coins, setCoins] = useState<BoardCoin[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<BoardCoin | null>(null);
  const load = useCallback(() => {
    setError('');
    fetchCoins()
      .then((c) => setCoins(sortBoard(c)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="flex flex-col gap-2">
      {coins === null && !error && <p className="text-xs text-[#98A2B3] text-center py-8">Loading BlastPad coins…</p>}
      {error && (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-xs text-[#F97066] text-center m-0">{error}</p>
          <button
            onClick={load}
            className="rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: '#F5B800', color: '#010101' }}
          >
            Retry
          </button>
        </div>
      )}
      {coins?.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-8">No coins launched yet.</p>}
      {coins?.map((c, i) => {
        const sold = big(c.sold);
        const ch = change24(c);
        return (
          <button
            key={c.token_id}
            onClick={() => setOpen(c)}
            className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3 text-left"
          >
            <span className="w-6 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
            <CoinArt id={c.token_id} />
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>
                ${c.sym} {c.graduated_at && <GradBadge />}
              </div>
              <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{c.name}</div>
              <Bar p={progress(sold)} />
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs font-semibold text-white">{money(marketCap(sold), rate)}</div>
              <div className="text-[10px]" style={{ color: ch === null ? '#667085' : ch >= 0 ? '#A1FF8B' : '#F97066' }}>
                {ch === null ? '—' : pct(ch)}
              </div>
            </div>
          </button>
        );
      })}
      {open && (
        <CoinSheet
          coin={open}
          rate={rate}
          onClose={() => setOpen(null)}
          onTraded={() => {
            fetchCoins()
              .then((c) => setCoins(sortBoard(c)))
              .catch(() => undefined);
          }}
        />
      )}
    </section>
  );
};

const BUY_PICKS = ['0.001', '0.01', '0.05', '0.1'];
const SLIPS = [100, 300, 500];

const CoinSheet = ({
  coin: initial,
  rate,
  onClose,
  onTraded,
}: {
  coin: BoardCoin;
  rate: number;
  onClose: () => void;
  onTraded: () => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [coin, setCoin] = useState(initial);
  const [indexed, setIndexed] = useState<boolean | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState(300);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ txid: string; graduated: boolean } | null>(null);
  // Real money: the first tap only asks; nothing is signed until Confirm.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [amount, side, slip]);
  useBackClose(!busy, onClose);

  const id = coin.token_id;
  const refresh = useCallback(() => {
    fetchCoin(id)
      .then((r) => {
        if (r.coin) setCoin(r.coin);
        setIndexed(r.indexed);
      })
      .catch(() => undefined);
    getBsv21Balances
      .execute(apiContext, {})
      .then((bs) =>
        setHeld(bs.filter((b) => b.id.replace('.', '_') === id).reduce((n, b) => n + BigInt(b.amt || '0'), 0n)),
      )
      .catch(() => setHeld(null));
  }, [apiContext, id]);
  useEffect(refresh, [refresh]);

  const sold = big(coin.sold);
  const amt: bigint = useMemo(() => {
    if (!amount) return 0n;
    if (side === 'sell') return /^\d+$/.test(amount) ? BigInt(amount) : 0n;
    const m = amount.match(/^(\d*)\.?(\d{0,8})\d*$/);
    return m ? BigInt((m[1] || '0') + (m[2] || '').padEnd(8, '0')) : 0n;
  }, [amount, side]);
  const q = amt > 0n ? (side === 'buy' ? quoteBuy(sold, amt) : quoteSell(sold, amt)) : null;
  const tooSmall = side === 'buy' && amt > 0n && amt < BigInt(MIN_BUY);
  const tooBig = side === 'buy' && amt > BigInt(MAX_BUY);
  const overHeld = side === 'sell' && (held === null || amt > held);
  const sellBlocked = side === 'sell' && indexed === false;
  const ready = !!q && q.tokens > 0n && !tooSmall && !tooBig && !overHeld && !sellBlocked && !busy;

  const go = async () => {
    if (!ready) return;
    setConfirming(false);
    setBusy(true);
    setError('');
    setDone(null);
    try {
      const account = chromeStorageService.getCurrentAccountObject().account;
      const address = account?.addresses.bsvAddress ?? '';
      if (!address) throw new Error('No active account.');
      const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
      const r = await trade(
        { client: apiContext.wallet, address, publicKey },
        { id, sym: coin.sym, icon: coinImage(id).replace('https://ordfs.network/', '') },
        side,
        amt,
        sold,
        slip,
        setStatus,
      );
      setDone(r);
      setAmount('');
      refresh();
      onTraded();
    } catch (e) {
      // The server's message, verbatim.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  const row = (label: string, value: string) => (
    <div className="flex justify-between text-sm">
      <span className="text-[#98A2B3]">{label}</span>
      <span className="text-white text-right">{value}</span>
    </div>
  );
  const input =
    'w-full h-11 rounded-xl px-3 text-base text-white outline-none border bg-[#0F1013] focus:border-[#FFD24D]';
  const picks =
    side === 'buy' ? BUY_PICKS : held && held > 0n ? [25n, 50n, 100n].map((p) => ((held * p) / 100n).toString()) : [];

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-label={`$${coin.sym}`}
        className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl px-5 pt-5 flex flex-col gap-3 border-t"
        style={{
          background: '#17191E',
          borderColor: LINE,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <CoinArt id={id} size={48} />
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold text-white">
              ${coin.sym} {coin.graduated_at && <GradBadge />}
            </div>
            <div className={`text-xs text-[#98A2B3] ${ELLIPSIS}`}>{coin.name}</div>
          </div>
          <button aria-label="Close" onClick={onClose} disabled={busy} className="p-1">
            <X size={18} color="#98A2B3" />
          </button>
        </div>
        {coin.description && <p className="text-xs text-[#98A2B3] m-0 leading-relaxed">{coin.description}</p>}

        <div className="flex flex-col gap-1.5 rounded-xl p-3" style={{ background: '#0F1013' }}>
          {row('Market cap', money(marketCap(sold), rate))}
          {row('Curve', `${(progress(sold) * 100).toFixed(1)}%`)}
          {row('BSV in the curve', `${fmtSats(poolSats(sold))} BSV`)}
          {row('Holders', Number(coin.holders ?? 0).toLocaleString())}
          {row('You hold', held === null ? '—' : `${held.toLocaleString()} $${coin.sym}`)}
          <Bar p={progress(sold)} />
        </div>

        <div className="flex gap-1 rounded-xl p-1 bg-[#0F1013]">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => {
                setSide(s);
                setAmount('');
                setError('');
              }}
              className="flex-1 rounded-lg py-1.5 text-xs font-semibold"
              style={{ background: side === s ? '#2b2f36' : 'transparent', color: side === s ? '#fff' : '#98A2B3' }}
            >
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-[#98A2B3]">
            {side === 'buy' ? 'Amount (BSV, fees included)' : `Amount ($${coin.sym})`}
          </span>
          <input
            inputMode={side === 'buy' ? 'decimal' : 'numeric'}
            value={amount}
            disabled={busy}
            onChange={(e) =>
              (side === 'buy' ? /^\d*\.?\d{0,8}$/ : /^\d*$/).test(e.target.value) && setAmount(e.target.value)
            }
            placeholder={side === 'buy' ? '0.01' : '1000000'}
            className={input}
            style={{ borderColor: LINE }}
          />
        </label>
        {picks.length > 0 && (
          <div className="flex gap-1.5">
            {picks.map((p, i) => (
              <button
                key={i}
                disabled={busy}
                onClick={() => setAmount(p)}
                className="flex-1 rounded-lg py-1 text-[11px] font-semibold bg-[#0F1013] text-[#98A2B3]"
              >
                {side === 'buy' ? p : ['25%', '50%', 'Max'][i]}
              </button>
            ))}
          </div>
        )}

        {sellBlocked && (
          <p className="text-[11px] text-[#98A2B3] m-0">
            Sells open once the token index picks it up (usually within a block or two).
          </p>
        )}

        {q && (
          <div className="flex flex-col gap-1.5 rounded-xl p-3" style={{ background: '#0F1013' }}>
            {row(
              'You get',
              side === 'buy'
                ? `${fmtTokens(q.tokens)} $${coin.sym}`
                : `${fmtSats(q.userSats)} BSV (${money(Number(q.userSats), rate)})`,
            )}
            {row(`Fees (${FEE_PCT})`, `${fmtSats(q.houseFee + q.routeFee)} BSV`)}
            {row('Price after', `${price(q.soldAfter).toPrecision(3)} sats`)}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-[#98A2B3]">
          <span className="flex-1">Max slippage</span>
          {SLIPS.map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => setSlip(s)}
              className="rounded-lg px-2.5 py-1 font-semibold"
              style={{ background: slip === s ? '#2b2f36' : '#0F1013', color: slip === s ? '#fff' : '#98A2B3' }}
            >
              {s / 100}%
            </button>
          ))}
        </div>

        {tooSmall && <p className="text-xs text-[#F97066] m-0">Minimum buy is {fmtSats(MIN_BUY)} BSV.</p>}
        {tooBig && <p className="text-xs text-[#F97066] m-0">Maximum buy is {fmtSats(MAX_BUY)} BSV.</p>}
        {overHeld && held !== null && <p className="text-xs text-[#F97066] m-0">That's more than you hold.</p>}
        {error && <p className="text-xs text-[#F97066] m-0 break-words">{error}</p>}
        {done && (
          <div className="text-xs text-[#A1FF8B] break-all">
            Done{done.graduated ? ' — this trade graduated the coin!' : ''}. Txid {done.txid}
            <button
              className="block mt-1 font-semibold"
              style={{ color: GOLD }}
              onClick={() => void openDappBrowser(wocTx(done.txid))}
            >
              View on WhatsOnChain ›
            </button>
          </div>
        )}

        {confirming && q ? (
          <div
            className="flex flex-col gap-2 rounded-xl p-3 border"
            style={{ background: '#0F1013', borderColor: GOLD }}
          >
            <p className="text-sm text-white m-0 leading-snug">
              {side === 'buy'
                ? `Buy ${exactTokens(q.tokens)} $${coin.sym} for ${exactBsv(q.userSats)} (${money(Number(q.userSats), rate)}), curve fees included?`
                : `Sell ${exactTokens(q.tokens)} $${coin.sym} for ${exactBsv(q.userSats)} (${money(Number(q.userSats), rate)}) after curve fees?`}
            </p>
            <p className="text-xs text-white m-0">
              {side === 'buy'
                ? `You get at least ${exactTokens((q.tokens * BigInt(10_000 - slip)) / BigInt(10_000))} $${coin.sym} or nothing is spent.`
                : `You get at least ${exactBsv((q.userSats * BigInt(10_000 - slip)) / BigInt(10_000))} or nothing is spent.`}
            </p>
            <p className="text-[11px] text-[#98A2B3] m-0">
              One real BSV transaction from this account, plus a few hundred sats network fee. Max slippage {slip / 100}
              %: if the price moves further, it is refused and nothing is spent. Trades are final.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 h-11 rounded-xl text-sm font-semibold bg-[#2b2f36] text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void go()}
                className="flex-1 h-11 rounded-xl text-sm font-bold"
                style={{ background: GOLD, color: '#010101' }}
              >
                Confirm {side === 'buy' ? 'buy' : 'sell'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!ready}
            onClick={() => setConfirming(true)}
            className="h-12 rounded-xl text-sm font-bold disabled:opacity-40"
            style={{ background: GOLD, color: '#010101' }}
          >
            {busy ? status || 'Working…' : side === 'buy' ? 'BUY' : 'SELL'}
          </button>
        )}
        <button
          className="text-xs font-semibold self-center"
          style={{ color: GOLD }}
          onClick={() => void openDappBrowser(coinPage(id))}
        >
          Open on BlastPad ›
        </button>
      </div>
    </div>,
    document.body,
  );
};
