import { useEffect, useMemo, useRef, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { fmtUsd, parseUsdInput } from '../money/money';
import { listOpnsName, unlistOpnsName } from './opnsBuy';
import {
  OPNS_SELL_USD,
  loadSellBatch,
  newSellBatch,
  runSellBatch,
  saveSellBatch,
  sellRemaining,
  sellTotals,
  type OwnedForSale,
  type SellState,
  usdOrSats,
} from './opnsSell';
import { OpnsSellSheet } from './OpnsSheets';

/**
 * bMint › OpNS names › Owned names: tick names, "List selected for $1", one approval, then each name is
 * listed in turn (OrdLock v2, sellOpns) with progress; the queue is saved so a closed window can Resume.
 */
const GOLD = '#FFD24D';
const GOLD_DIM = 'rgba(255,210,77,0.14)';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.58)';
const HAIR = 'rgba(255,255,255,0.08)';
const GREEN = '#3ddc84';
const RED = '#ff5a5a';
const CARD_BG = 'rgba(12,12,14,0.92)';

const goldBtn =
  'rounded-xl font-semibold border-0 cursor-pointer transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const ghostBtn =
  'rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer bg-transparent border-0 transition-colors duration-150 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 disabled:cursor-not-allowed';

const STATUS: Record<string, string> = { pending: 'Waiting', listing: 'Listing…', done: 'Listed', error: 'Error' };

export const OpnsSellSection = (p: {
  ctx: OneSatContext | undefined;
  identityAddress: string;
  rate: number;
  owned: OwnedForSale[];
  onChanged: () => void;
}) => {
  const { ctx, identityAddress, rate, owned } = p;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<SellState | null>(() => loadSellBatch(identityAddress));
  const [running, setRunning] = useState(false);
  const [sheet, setSheet] = useState<SellState | null>(null);
  const [busyId, setBusyId] = useState('');
  const [msg, setMsg] = useState('');
  const abort = useRef<AbortController | null>(null);
  const ownedRef = useRef(owned);
  ownedRef.current = owned;

  useEffect(() => setBatch(loadSellBatch(identityAddress)), [identityAddress]);
  useEffect(() => () => abort.current?.abort(), []);

  const unlisted = useMemo(() => owned.filter((o) => o.listedSats === null), [owned]);
  const chosen = unlisted.filter((o) => picked.has(o.name));
  const usdFor = (name: string) => parseUsdInput(prices[name] ?? '') ?? OPNS_SELL_USD;
  const customPrices = Object.fromEntries(chosen.map((o) => [o.name, usdFor(o.name)]));
  const totalUsd = chosen.reduce((a, o) => a + usdFor(o.name), 0);
  const allSame = chosen.every((o) => usdFor(o.name) === OPNS_SELL_USD);
  const allPicked = unlisted.length > 0 && chosen.length === unlisted.length;

  const toggle = (name: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const run = async (start: SellState) => {
    if (!ctx) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setMsg('');
    try {
      const r = await runSellBatch(
        {
          list: (it) => listOpnsName(ctx, it.id, it.sats),
          isListed: (n) => ownedRef.current.some((o) => o.name === n && o.listedSats !== null),
          save: (s) => saveSellBatch(identityAddress, s),
          onUpdate: setBatch,
        },
        start,
        ctl.signal,
      );
      if (r.stopped === 'error') setMsg(`Stopped: ${r.error}. Fix it, then Resume.`);
      else if (r.stopped === 'cancelled') setMsg('Paused. Names already listed stay listed; Resume any time.');
      p.onChanged();
    } finally {
      abort.current = null;
      setRunning(false);
    }
  };

  // Approve: the price in sats is fixed now, at the live rate, and shown on the sheet.
  const review = async () => {
    setMsg('');
    const live = await fetchExchangeRate('main').catch(() => rate);
    const b = newSellBatch(chosen, live > 0 ? live : rate, customPrices);
    if (!b) setMsg("Couldn't get the BSV price. Try again in a minute.");
    else setSheet(b);
  };
  const approve = () => {
    if (!sheet) return;
    const b = sheet;
    setSheet(null);
    setPicked(new Set());
    saveSellBatch(identityAddress, b);
    setBatch(b);
    void run(b);
  };
  const clear = () => {
    saveSellBatch(identityAddress, null);
    setBatch(null);
    setMsg('');
  };
  const unlist = async (o: OwnedForSale) => {
    if (!ctx) return;
    setBusyId(o.id);
    setMsg('');
    try {
      await unlistOpnsName(ctx, o.id);
      p.onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setBusyId('');
    }
  };

  const left = sellRemaining(batch);
  const showProgress = !!batch && batch.items.length > 0;
  const done = showProgress ? batch.items.length - left : 0;

  if (!owned.length && !showProgress) return null;

  return (
    <section
      aria-labelledby="opns-owned"
      className="rounded-2xl p-4 sm:p-5 flex flex-col gap-3"
      style={{
        background: CARD_BG,
        border: `1px solid ${showProgress || chosen.length ? 'rgba(255,210,77,0.28)' : HAIR}`,
      }}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 id="opns-owned" className="m-0 text-[15px] font-semibold tracking-tight" style={{ color: TEXT }}>
            Owned names
          </h2>
          <span className="text-xs" style={{ color: MUTED }}>
            Tick names to sell. Anyone can buy a listed name; cancel any time before it sells.
          </span>
        </div>
        {unlisted.length > 1 && !showProgress && (
          <button
            type="button"
            className={`${ghostBtn} shrink-0 whitespace-nowrap`}
            style={{ color: GOLD }}
            onClick={() => setPicked(allPicked ? new Set() : new Set(unlisted.map((o) => o.name)))}
          >
            {allPicked ? 'Select none' : 'Select all'}
          </button>
        )}
      </header>

      {showProgress && (
        <div
          className="flex flex-col gap-2 rounded-xl p-3"
          style={{ background: '#0b0b0d', border: `1px solid ${HAIR}` }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-semibold" style={{ color: TEXT }}>
              {running ? 'Listing' : left ? 'Paused' : 'Listed'} · {done} of {batch.items.length}
            </span>
            {running ? (
              <button
                type="button"
                className={ghostBtn}
                style={{ color: TEXT, border: `1px solid ${HAIR}` }}
                onClick={() => abort.current?.abort()}
              >
                Pause
              </button>
            ) : (
              <span className="flex gap-2">
                <button type="button" className={ghostBtn} style={{ color: MUTED }} onClick={clear}>
                  {left ? 'Clear' : 'Done'}
                </button>
                {left > 0 && (
                  <button
                    type="button"
                    className={`${goldBtn} px-4 py-1.5 text-xs`}
                    style={{ background: GOLD, color: '#000' }}
                    disabled={!ctx}
                    onClick={() => void run(batch)}
                  >
                    Resume
                  </button>
                )}
              </span>
            )}
          </div>
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: GOLD_DIM }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={batch.items.length}
            aria-valuenow={done}
          >
            <div
              className="h-full rounded-full transition-[width] duration-300 ease-out"
              style={{ background: GOLD, width: `${(done / batch.items.length) * 100}%` }}
            />
          </div>
          <ul className="m-0 p-0 list-none flex flex-col">
            {batch.items.map((it) => (
              <li key={it.name} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                <span className="font-medium break-all" style={{ color: TEXT }}>
                  {it.name} <span style={{ color: MUTED }}>· {fmtUsd(it.usd)}</span>
                </span>
                <span
                  className="shrink-0 text-right"
                  style={{
                    color: it.status === 'done' ? GREEN : it.status === 'listing' ? GOLD : it.note ? RED : MUTED,
                  }}
                >
                  {STATUS[it.status]}
                  {it.note ? ` · ${it.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {owned.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col">
          {owned.map((o) => {
            const listed = o.listedSats !== null;
            const on = picked.has(o.name);
            return (
              <li
                key={o.name}
                className="flex items-center justify-between gap-3 py-2 text-[13px]"
                style={{ borderTop: `1px solid ${HAIR}` }}
              >
                <label className={`flex items-center gap-3 min-w-0 ${listed || showProgress ? '' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={listed || running}
                    onChange={() => toggle(o.name)}
                    className="w-4 h-4 shrink-0 accent-[#FFD24D] cursor-pointer disabled:cursor-not-allowed"
                    aria-label={`Sell ${o.name}`}
                  />
                  <span className="font-medium break-all" style={{ color: listed ? MUTED : TEXT }}>
                    {o.name}
                  </span>
                </label>
                <span className="flex items-center gap-2 shrink-0">
                  {listed ? (
                    <>
                      <span className="text-xs font-semibold" style={{ color: GOLD }}>
                        For sale · {usdOrSats(o.listedSats ?? 0, rate)}
                      </span>
                      <button
                        type="button"
                        className={ghostBtn}
                        style={{ color: MUTED, border: `1px solid ${HAIR}` }}
                        disabled={!ctx || busyId === o.id || running}
                        onClick={() => void unlist(o)}
                      >
                        {busyId === o.id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </>
                  ) : on ? (
                    <label className="flex items-center gap-1 text-xs" style={{ color: MUTED }}>
                      $
                      <input
                        inputMode="decimal"
                        value={prices[o.name] ?? String(OPNS_SELL_USD)}
                        onChange={(e) => setPrices((x) => ({ ...x, [o.name]: e.target.value }))}
                        aria-label={`Price for ${o.name} in dollars`}
                        className="w-16 rounded-lg px-2 py-1 text-xs text-right outline-none focus-visible:ring-2 tabular-nums"
                        style={{ background: '#0b0b0d', color: TEXT, border: `1px solid ${HAIR}` }}
                      />
                    </label>
                  ) : (
                    <span className="text-xs" style={{ color: MUTED }}>
                      Not listed
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {unlisted.length > 0 && (
        <button
          type="button"
          className={`${goldBtn} w-full py-3 text-[14px]`}
          style={{ background: GOLD, color: '#000' }}
          disabled={!ctx || !chosen.length || running}
          onClick={() => void review()}
        >
          {!chosen.length
            ? `List selected for ${fmtUsd(OPNS_SELL_USD)}`
            : allSame
              ? `List ${chosen.length} selected for ${fmtUsd(OPNS_SELL_USD)} each`
              : `List ${chosen.length} selected · ${fmtUsd(totalUsd)} total`}
        </button>
      )}

      {msg && (
        <p className="m-0 text-xs" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}

      {sheet && (
        <OpnsSellSheet
          names={sheet.items.map((i) => i.name)}
          totalSats={sellTotals(sheet).sats}
          totalUsd={sellTotals(sheet).usd}
          onAllow={approve}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
};
