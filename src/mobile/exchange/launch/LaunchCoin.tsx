import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Check, ImagePlus, Rocket } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useBackClose } from '../../backStack';
import { money, moneyWithSats, useBsvUsd } from '../../money/money';
import { checkSize, formatBytes, iconFile, notifyMinted, mintFeeAddress, withFeeOutput } from '../../mint/mint';
import { inscribeIcon } from '../../tickets/mintTicket';
import { MAX_ICON_BYTES, suggestTicker } from '../../tickets/tickets';
import { deployToken, type MintedToken } from '../../tokens/mintToken';
import { showOnWallet } from '../../tokens/indexFund';
import { RETURNS_WARNING, hasReturnsWording } from '../../tokens/returnsWording';
import type { TokenForm } from '../../tokens/token';
import { ErrorActions } from '../../errors/ErrorActions';
import { tradeRoute } from '../exchangeData';
import { approvalLines, emptyLaunchForm, launchCost, validateLaunch } from './launch';

/**
 * Exchange › Launchpad › Launch your own coin: name, ticker, supply (1B default), icon, then ONE
 * approval sheet inside the wallet (owner rule: one sheet, nothing to untick), then the result with
 * the coin's Exchange page. Signing is the active account's own wallet (apiContext); nothing is
 * broadcast before Allow.
 */
const GOLD = '#F5B800';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

export const LaunchCoin = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const navigate = useNavigate();
  const rate = useBsvUsd();
  const [form, setForm] = useState<TokenForm>(emptyLaunchForm);
  const [tickerTouched, setTickerTouched] = useState(false);
  const [icon, setIcon] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState<MintedToken | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (icon && URL.revokeObjectURL(icon.url)), [icon]);

  const cost = launchCost(icon?.file.size ?? 0, chromeStorageService.getCustomFeeRate());
  const fmt = (sats: number) => money(sats, rate);

  const set = (k: keyof TokenForm) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v, ...(k === 'name' && !tickerTouched ? { ticker: suggestTicker(v) } : {}) }));

  const pickIcon = async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) return setError('Pick an image for the icon.');
    try {
      const small = await iconFile(file);
      const size = checkSize(small.size, MAX_ICON_BYTES);
      if (!size.ok) return setError(size.message);
      setIcon({ file: small, url: URL.createObjectURL(small) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read this image');
    }
  };

  const review = () => {
    const err = validateLaunch(form);
    setError(err ?? '');
    if (!err) setSheet(true);
  };

  const launch = async () => {
    const err = validateLaunch(form);
    if (err) {
      setSheet(false);
      return setError(err);
    }
    setBusy('Launching…');
    try {
      const iconOutpoint = icon ? await inscribeIcon(apiContext, icon.file, form.ticker.trim(), 'coin') : null;
      // The flat launch fee rides on the deploy tx as its own labelled output (no fee address = none).
      const feeCtx = withFeeOutput(apiContext, cost.launchFeeSats, mintFeeAddress());
      const token = await deployToken(feeCtx, form, { icon: iconOutpoint, feeSats: 0 });
      void showOnWallet(chromeStorageService, token.tokenId);
      notifyMinted();
      setSheet(false);
      setDone(token);
    } catch (e) {
      setSheet(false);
      setError(e instanceof Error ? e.message : 'Launch failed');
    } finally {
      setBusy('');
    }
  };

  const input = 'w-full rounded-xl px-3 py-2.5 text-sm outline-none border bg-transparent text-white';
  const inputStyle = { borderColor: LINE };

  if (done)
    return (
      <section className="flex flex-col gap-3 rounded-2xl border p-4" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-2 text-white font-bold">
          <Check size={18} color="#A1FF8B" /> ${done.ticker} is launched
        </div>
        <p className="text-sm m-0" style={{ color: MUTED }}>
          {BigInt(done.supply).toLocaleString('en-US')} ${done.ticker} are in your wallet. Its Exchange page is live; it
          shows trades once the token is indexed (usually a few minutes).
        </p>
        <p className="text-[11px] break-all m-0" style={{ color: MUTED }}>
          {done.tokenId}
        </p>
        <button
          type="button"
          onClick={() => navigate(tradeRoute(done.tokenId))}
          className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold"
        >
          Open ${done.ticker} on the Exchange
        </button>
        <button
          type="button"
          onClick={() => {
            setDone(null);
            setForm(emptyLaunchForm());
            setTickerTouched(false);
            setIcon(null);
          }}
          className="text-sm bg-transparent border-0 cursor-pointer"
          style={{ color: GOLD }}
        >
          Launch another
        </button>
      </section>
    );

  return (
    <section className="flex flex-col gap-3 rounded-2xl border p-4" style={{ borderColor: LINE }}>
      <h2 className="flex items-center gap-2 text-lg font-extrabold text-white m-0">
        <Rocket size={18} color={GOLD} /> Launch your own coin
      </h2>
      <p className="text-xs m-0" style={{ color: MUTED }}>
        A BSV-21 token made from your wallet. The whole supply lands in your wallet and it gets its own Exchange page.
      </p>
      <input
        className={input}
        style={inputStyle}
        placeholder="Coin name"
        aria-label="Coin name"
        value={form.name}
        maxLength={64}
        onChange={(e) => set('name')(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          className={input}
          style={inputStyle}
          placeholder="Ticker"
          aria-label="Ticker"
          value={form.ticker}
          maxLength={32}
          onChange={(e) => {
            setTickerTouched(true);
            set('ticker')(e.target.value.toUpperCase().replace(/^\$/, ''));
          }}
        />
        <input
          className={input}
          style={inputStyle}
          placeholder="Supply"
          aria-label="Supply"
          inputMode="numeric"
          value={form.supply}
          onChange={(e) => set('supply')(e.target.value)}
        />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void pickIcon(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex items-center gap-3 rounded-xl border border-dashed px-3 py-2 cursor-pointer bg-transparent text-left text-sm"
        style={{ borderColor: GOLD, color: GOLD }}
      >
        {icon ? (
          <img src={icon.url} alt="" className="h-10 w-10 rounded-lg object-cover" />
        ) : (
          <span className="h-10 w-10 rounded-lg flex items-center justify-center" style={{ background: '#17191E' }}>
            <ImagePlus size={18} />
          </span>
        )}
        <span>
          {icon ? 'Change icon' : 'Add an icon'}
          {icon && (
            <span className="block text-[10px]" style={{ color: MUTED }}>
              {formatBytes(icon.file.size)} · inscribed with the coin
            </span>
          )}
        </span>
      </button>
      <textarea
        className={input}
        style={inputStyle}
        placeholder="Description (optional)"
        rows={2}
        value={form.description}
        maxLength={1000}
        onChange={(e) => set('description')(e.target.value)}
      />
      {hasReturnsWording(`${form.name} ${form.description}`) && (
        <p className="text-xs m-0" style={{ color: GOLD }}>
          {RETURNS_WARNING}
        </p>
      )}
      <p className="text-xs m-0" style={{ color: MUTED }}>
        Launch fee: {cost.launchFeeSats > 0 ? `${fmt(cost.launchFeeSats)} flat` : 'none'} · network ≈{' '}
        {fmt(cost.networkSats)} · total ≈ {moneyWithSats(cost.totalSats, rate)}. No share of your coin is taken.
      </p>
      {error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm m-0" style={{ color: '#FF6B6B' }}>
            {error}
          </p>
          <ErrorActions message={error} />
        </div>
      )}
      <button type="button" onClick={review} className="bw-pill bw-pill-gold min-h-[44px] w-full text-sm font-bold">
        Review launch
      </button>
      {sheet && (
        <ApproveSheet
          lines={approvalLines(form, cost, fmt, !!icon)}
          total={moneyWithSats(cost.totalSats, rate)}
          busy={busy}
          onAllow={() => void launch()}
          onCancel={() => !busy && setSheet(false)}
        />
      )}
    </section>
  );
};

/** The one approval sheet: every step listed, one Allow, nothing to untick. */
const ApproveSheet = ({
  lines,
  total,
  busy,
  onAllow,
  onCancel,
}: {
  lines: { label: string; value: string }[];
  total: string;
  busy: string;
  onAllow: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/70" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Approve launch"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-2xl p-5 flex flex-col gap-3"
        style={{
          background: '#0d0e11',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center gap-2 text-white text-lg font-extrabold">
          <Rocket size={18} color={GOLD} /> Launch this coin?
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2" style={{ color: MUTED }}>
                <Check size={14} color="#A1FF8B" /> {l.label}
              </span>
              <span className="text-white font-semibold text-right">{l.value}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t pt-3 text-sm" style={{ borderColor: LINE }}>
          <span style={{ color: MUTED }}>Total</span>
          <span className="text-white font-bold">{total}</span>
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={onAllow}
          className="bw-pill bw-pill-gold min-h-[48px] w-full text-base font-bold disabled:opacity-60"
        >
          {busy || 'Allow'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={onCancel}
          className="text-sm bg-transparent border-0 cursor-pointer disabled:opacity-40"
          style={{ color: MUTED }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};
