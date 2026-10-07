import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { usePrefs } from '../settings/usePrefs';
import { saveTextFile } from '../agents/saveText';
import { computeGains, dayIn, NOT_TAX_ADVICE, taxYearOf, totalsByAsset, type Disposal } from './gains';
import { assetKeyOf, buildLedger, gainsCsv, loadOverrides, saveOverrides, type Overrides } from './taxLedger';
import { dayKey, nearestPrevious, type HistoryRow } from './txHistory';
import { usdPerGbp, type DayRates } from './fiatRates';
import { assetText } from './historyEvents';

const CARD = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const GOLD = '#FFD24D';
const GREEN = '#32D583';
const RED = '#F97066';

const fmtQty = (asset: string, q: number) => (asset === 'BSV' ? `${(q / 1e8).toFixed(8).replace(/\.?0+$/, '')} BSV` : q.toLocaleString());

/** History › Gains: realised gains and losses per asset per tax year, with the accountant CSV. */
export const GainsView = ({ rows, account }: { rows: HistoryRow[]; account: string }) => {
  const [prefs] = usePrefs();
  const uk = prefs.taxCountry === 'uk';
  const currency = uk ? 'GBP' : 'USD';
  const sym = uk ? '£' : '$';
  const [gbp, setGbp] = useState<DayRates | null>(null);
  const [ovr, setOvr] = useState<Overrides>(loadOverrides);
  const [year, setYear] = useState('');
  const [review, setReview] = useState(false);

  useEffect(() => {
    if (!uk || !rows.length) return;
    let live = true;
    void usdPerGbp(Math.min(...rows.map((r) => r.time))).then((m) => live && setGbp(m));
    return () => {
      live = false;
    };
  }, [uk, rows]);

  const price = useMemo(
    () =>
      (r: HistoryRow): number | undefined => {
        if (r.usdRate === undefined) return undefined;
        if (!uk) return r.usdRate;
        const per = gbp ? nearestPrevious(gbp, dayKey(r.time)) : undefined;
        return per ? r.usdRate / per : undefined;
      },
    [uk, gbp],
  );

  const { disposals, warnings } = useMemo(() => {
    const { events, warnings } = buildLedger(rows, price, (ms) => dayIn(ms, uk), ovr);
    return { disposals: computeGains(events, uk ? 'hmrc' : 'fifo'), warnings };
  }, [rows, price, uk, ovr]);

  const years = useMemo(() => [...new Set(disposals.map((d) => taxYearOf(d.day, uk)))].sort().reverse(), [disposals, uk]);
  const shownYear = years.includes(year) ? year : (years[0] ?? '');
  const inYear = disposals.filter((d) => taxYearOf(d.day, uk) === shownYear);
  const totals = totalsByAsset(inYear);
  const sum = totals.reduce((a, t) => ({ proceeds: a.proceeds + t.proceeds, cost: a.cost + t.cost, gains: a.gains + t.gains, losses: a.losses + t.losses }), {
    proceeds: 0,
    cost: 0,
    gains: 0,
    losses: 0,
  });
  const money = (raw: number) => {
    const n = Math.round(raw * 100) / 100;
    return `${n < 0 ? '-' : ''}${sym}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const update = (o: Overrides) => {
    setOvr(o);
    saveOverrides(o);
  };
  const toggleOwn = (txid: string) =>
    update({ ...ovr, ownWallet: ovr.ownWallet.includes(txid) ? ovr.ownWallet.filter((t) => t !== txid) : [...ovr.ownWallet, txid] });
  const setValue = (key: string, v: string) => {
    const lotValue = { ...ovr.lotValue };
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) delete lotValue[key];
    else lotValue[key] = n;
    update({ ...ovr, lotValue });
  };

  const exportCsv = () =>
    void saveTextFile(
      `bwallet-${account.replace(/[^\w.-]+/g, '-')}-gains-${shownYear || 'all'}.csv`,
      gainsCsv(inYear, { uk, currency, method: uk ? 'HMRC share pooling (same day, 30 days, section 104)' : 'FIFO' }),
      'text/csv;charset=utf-8',
    );

  const transfers = rows.filter(
    (r) => r.direction !== 'self' && (r.type === 'transfer-in' || r.type === 'transfer-out' || r.type === 'receive' || r.type === 'send') && taxYearOf(dayIn(r.time, uk), uk) === shownYear,
  );

  return (
    <div className="flex-1 overflow-y-auto px-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}>
      <p className="text-xs mt-4" style={{ color: MUTED }}>
        {uk
          ? 'UK rules: HMRC share pooling (same day, then 30 days, then the section 104 pool), in pounds, tax year 6 April to 5 April.'
          : 'First in, first out, in US dollars, calendar year.'}{' '}
        Change in Settings › Tax reports. BSV counts as an asset too: spending it is a disposal.
      </p>
      <p className="text-xs mt-2 rounded-xl p-3" style={{ background: CARD, color: '#fff' }}>
        {NOT_TAX_ADVICE}
      </p>
      {uk && !gbp && rows.length > 0 && (
        <div className="text-xs mt-2" style={{ color: MUTED }}>
          Loading pound rates from the Bank of England…
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Tax year">
        {years.map((y) => (
          <button
            key={y}
            type="button"
            aria-pressed={y === shownYear}
            onClick={() => setYear(y)}
            className="px-3 py-1 rounded-full text-xs border-0 cursor-pointer"
            style={{ background: y === shownYear ? GOLD : CARD, color: y === shownYear ? '#000' : '#fff' }}
          >
            {uk ? `Tax year ${y}` : y}
          </button>
        ))}
      </div>
      {years.length === 0 && (
        <div className="text-sm mt-6 text-center" style={{ color: MUTED }}>
          No disposals yet.
        </div>
      )}

      {shownYear && (
        <>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {(
              [
                ['Proceeds', sum.proceeds, '#fff'],
                ['Allowable costs', sum.cost, '#fff'],
                ['Gains', sum.gains, GREEN],
                ['Losses', -sum.losses, RED],
              ] as const
            ).map(([k, v, c]) => (
              <div key={k} className="rounded-xl p-3" style={{ background: CARD }}>
                <div className="text-xs" style={{ color: MUTED }}>
                  {k}
                </div>
                <div className="font-semibold" style={{ color: c }}>
                  {money(v)}
                </div>
              </div>
            ))}
          </div>
          <div className="text-sm mt-2 font-semibold" style={{ color: sum.gains - sum.losses >= 0 ? GREEN : RED }}>
            Net {money(sum.gains - sum.losses)} · {inYear.length} disposals
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="w-full mt-3 flex items-center justify-center gap-2 rounded-xl py-3 border-0 cursor-pointer font-semibold"
            style={{ background: GOLD, color: '#000' }}
          >
            <Download size={16} /> Export disposals CSV
          </button>

          <div className="text-xs mt-4 mb-1" style={{ color: MUTED }}>
            By asset
          </div>
          <div className="rounded-xl overflow-hidden" style={{ background: CARD }}>
            {totals.map((t) => (
              <div key={t.asset} className="flex justify-between gap-2 px-3 py-2 text-sm" style={{ borderTop: `1px solid ${LINE}` }}>
                <span className="truncate">{t.label}</span>
                <span style={{ color: MUTED }}>{t.disposals}×</span>
                <span className="font-semibold" style={{ color: t.net >= 0 ? GREEN : RED }}>
                  {money(t.net)}
                </span>
              </div>
            ))}
          </div>

          <div className="text-xs mt-4 mb-1" style={{ color: MUTED }}>
            Disposals
          </div>
          <div className="flex flex-col gap-2">
            {inYear.slice(-200).reverse().map((d) => (
              <DisposalRow key={`${d.asset}-${d.day}-${d.txids[0]}`} d={d} money={money} />
            ))}
          </div>

          {warnings.length > 0 && (
            <div className="text-xs mt-3" style={{ color: RED }}>
              {warnings.length} item{warnings.length > 1 ? 's' : ''} left out: {warnings.slice(0, 3).map((w) => w.text).join('; ')}
            </div>
          )}

          <button
            type="button"
            onClick={() => setReview((v) => !v)}
            className="mt-4 text-sm bg-transparent border-0 cursor-pointer"
            style={{ color: GOLD }}
          >
            {review ? 'Hide' : 'Review'} transfers ({transfers.length}): mark own-wallet moves, enter costs
          </button>
          {review && (
            <div className="flex flex-col gap-2 mt-2">
              {transfers.slice(0, 300).map((r) => {
                const key = `${r.txid}|${assetKeyOf(r)}`;
                const own = ovr.ownWallet.includes(r.txid);
                return (
                  <div key={r.txid} className="rounded-xl p-3 text-xs" style={{ background: CARD }}>
                    <div className="flex justify-between gap-2">
                      <span className="font-semibold">
                        {r.asset ? assetText(r.asset) : `${(r.amountSats / 1e8).toFixed(8).replace(/\.?0+$/, '')} BSV`} {r.direction === 'in' ? 'in' : 'out'}
                      </span>
                      <span style={{ color: MUTED }}>{new Date(r.time).toLocaleDateString()}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={own} onChange={() => toggleOwn(r.txid)} /> Own wallet
                      </label>
                      {!own && (
                        <label className="flex items-center gap-1" style={{ color: MUTED }}>
                          {r.direction === 'in' ? 'Cost' : 'Value'} {sym}
                          <input
                            inputMode="decimal"
                            aria-label={r.direction === 'in' ? 'Cost' : 'Value'}
                            defaultValue={ovr.lotValue[key] ?? ''}
                            placeholder={r.asset ? '0' : 'market'}
                            onBlur={(e) => setValue(key, e.target.value)}
                            className="w-20 rounded px-2 py-1"
                            style={{ background: '#0d0e11', color: '#fff', border: `1px solid ${LINE}` }}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const RULES: Record<string, string> = { 'same-day': 'same day', 'bed-and-breakfast': '30-day', s104: 'pool', fifo: 'FIFO', unmatched: 'no cost' };

const DisposalRow = ({ d, money }: { d: Disposal; money: (n: number) => string }) => (
  <div className="rounded-xl p-3" style={{ background: CARD }}>
    <div className="flex justify-between gap-2 text-sm">
      <span className="font-semibold truncate">
        {fmtQty(d.asset, d.qty)} {d.asset === 'BSV' ? '' : d.label}
      </span>
      <span className="font-semibold" style={{ color: d.gain >= 0 ? GREEN : RED }}>
        {money(d.gain)}
      </span>
    </div>
    <div className="flex justify-between gap-2 text-xs" style={{ color: MUTED }}>
      <span>{d.day}</span>
      <span>
        {money(d.proceeds)} − {money(d.cost)} · {[...new Set(d.matches.map((m) => RULES[m.rule]))].join(' + ')}
      </span>
    </div>
    {d.flags.length > 0 && (
      <div className="text-xs mt-1" style={{ color: GOLD }}>
        {d.flags.join('; ')}
      </div>
    )}
  </div>
);

export default GainsView;
