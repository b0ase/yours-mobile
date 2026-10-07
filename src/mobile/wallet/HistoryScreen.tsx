import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, ArrowUpRight, Download, ExternalLink, FileText, RefreshCw, Repeat, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchExchangeRate } from '../../utils/wallet';
import { isNative } from '../native';
import { saveTextFile } from '../agents/saveText';
import { getAgentAccount } from '../agents/agentAccounts';
import {
  balances,
  bsvString,
  buildRows,
  fileStem,
  filterRange,
  rangeFor,
  ratesByDay,
  toCsv,
  totals,
  usdValue,
  withRates,
  type HistoryRow,
  type LocalInfo,
  type RangePreset,
} from './txHistory';
import { fetchAccountTxs, fetchDailyRates, fetchLocalInfo, type Progress } from './txHistoryFetch';
import { statementHtml } from './txStatement';

const BG = '#0d0e11';
const CARD = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const GOLD = '#FFD24D';
const GREEN = '#32D583';
const RED = '#F97066';

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

const fmtBsv = (sats: number) => `${bsvString(sats).replace(/\.?0+$/, '') || '0'} BSV`;
const fmtSats = (sats: number) => `${sats.toLocaleString()} sats`;

type Loaded = { rows: HistoryRow[]; at: number };

/** Activity / History for the current account: full on-chain history, summary, CSV and printable statement. */
export const HistoryScreen = ({ onClose }: { onClose: () => void }) => {
  const { chromeStorageService, apiContext } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const addrs = account?.addresses;
  const addresses = useMemo(
    () => [...new Set([addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress].filter((a): a is string => !!a))],
    [addrs?.bsvAddress, addrs?.ordAddress, addrs?.identityAddress],
  );
  const accountName = account?.name || addrs?.bsvAddress || 'Account';
  const [data, setData] = useState<Loaded | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [shown, setShown] = useState(100);

  const load = useCallback(async () => {
    setError('');
    setProgress({ phase: 'Starting', done: 0, total: 1 });
    try {
      const key = apiContext.wocApiKey || undefined;
      const [txs, local] = await Promise.all([
        fetchAccountTxs(addresses, key, setProgress),
        fetchLocalInfo(apiContext.wallet?.listActions?.bind(apiContext.wallet) as Parameters<typeof fetchLocalInfo>[0]),
      ]);
      // Pots and agent accounts: unlabelled outgoing payments are pot payments / agent spend.
      const kind = getAgentAccount(addrs?.identityAddress)?.kind;
      const now = Date.now();
      let rows = buildRows(txs, new Set(addresses), local as Map<string, LocalInfo>, now);
      if (kind)
        rows = rows.map((r) =>
          r.direction === 'out' && r.label === 'send' ? { ...r, label: kind === 'pot' ? 'pot payment' : 'agent spend' } : r,
        );
      setProgress({ phase: 'Prices', done: 1, total: 1 });
      const oldest = rows.length ? Math.min(...rows.map((r) => r.time)) : now;
      const [daily, current] = await Promise.all([
        fetchDailyRates(Math.floor(oldest / 1000) - 86400, Math.floor(now / 1000), key),
        fetchExchangeRate(apiContext.chain, apiContext.wocApiKey).catch(() => 0),
      ]);
      setData({ rows: withRates(rows, ratesByDay(daily), current), at: now });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }, [addresses, addrs?.identityAddress, apiContext]);

  useEffect(() => {
    void load();
  }, [load]);

  const range = useMemo(() => rangeFor(preset, data?.at ?? Date.now(), custom), [preset, custom, data?.at]);
  const rows = useMemo(() => (data ? filterRange(data.rows, range) : []), [data, range]);
  const sum = totals(rows);
  const bal = data ? balances(data.rows, range) : null;
  const stem = fileStem(accountName, range);

  const exportCsv = () => void saveTextFile(`${stem}.csv`, toCsv(rows, accountName), 'text/csv;charset=utf-8');
  const exportPdf = () => {
    const html = statementHtml({
      account: accountName,
      addresses,
      range,
      rows,
      opening: bal?.opening ?? null,
      closing: bal?.closing ?? null,
      autoPrint: !isNative,
    });
    if (!isNative) {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (w) return;
    }
    // Phones: share the statement page (open it, then Print → Save as PDF).
    void saveTextFile(`${stem}-statement.html`, html, 'text/html');
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return createPortal(
    <div
      role="dialog"
      aria-label="Transaction history"
      className="fixed inset-0 flex flex-col"
      style={{ background: BG, color: '#fff', zIndex: 2000, paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="flex-1 min-w-0">
          <div className="font-semibold">History</div>
          <div className="text-xs truncate" style={{ color: MUTED }}>
            {accountName}
          </div>
        </div>
        <button
          type="button"
          aria-label="Reload history"
          disabled={!!progress}
          onClick={() => void load()}
          className="p-2 bg-transparent border-0 cursor-pointer"
          style={{ color: MUTED }}
        >
          <RefreshCw size={18} className={progress ? 'animate-spin' : ''} />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 bg-transparent border-0 cursor-pointer" style={{ color: '#fff' }}>
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}>
        {progress && (
          <div className="mt-4" aria-live="polite">
            <div className="text-xs mb-1" style={{ color: MUTED }}>
              Loading full history… {progress.phase}
              {progress.total > 1 ? ` (${progress.done}/${progress.total})` : ''}
            </div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: LINE }}>
              <div className="h-full" style={{ width: `${Math.max(4, pct)}%`, background: GOLD, transition: 'width .3s' }} />
            </div>
          </div>
        )}
        {error && (
          <div className="mt-4 text-sm" style={{ color: RED }}>
            {error}{' '}
            <button type="button" onClick={() => void load()} className="underline bg-transparent border-0" style={{ color: GOLD }}>
              Retry
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-4" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              onClick={() => {
                setPreset(p.id);
                setShown(100);
              }}
              className="px-3 py-1 rounded-full text-xs border-0 cursor-pointer"
              style={{ background: preset === p.id ? GOLD : CARD, color: preset === p.id ? '#000' : '#fff' }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex gap-2 mt-2 text-xs items-center" style={{ color: MUTED }}>
            <label className="flex flex-col gap-1">
              From
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="rounded px-2 py-1" style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }} />
            </label>
            <label className="flex flex-col gap-1">
              To
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="rounded px-2 py-1" style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }} />
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 mt-4">
          {[
            ['In', sum.inSats, GREEN],
            ['Out', -sum.outSats, RED],
            ['Fees', -sum.feeSats, MUTED],
            ['Net', sum.netSats, sum.netSats >= 0 ? GREEN : RED],
          ].map(([k, v, c]) => (
            <div key={k as string} className="rounded-xl p-3" style={{ background: CARD }}>
              <div className="text-xs" style={{ color: MUTED }}>
                {k as string}
              </div>
              <div className="font-semibold" style={{ color: c as string }}>
                {fmtBsv(v as number)}
              </div>
              <div className="text-xs" style={{ color: MUTED }}>
                {fmtSats(v as number)}
              </div>
            </div>
          ))}
        </div>
        {bal && (
          <div className="text-xs mt-2" style={{ color: MUTED }}>
            {sum.count} transactions · opening {fmtBsv(bal.opening)} · closing {fmtBsv(bal.closing)}
          </div>
        )}

        <div className="flex gap-2 mt-4">
          <button type="button" disabled={!data} onClick={exportCsv} className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 border-0 cursor-pointer font-semibold" style={{ background: GOLD, color: '#000', opacity: data ? 1 : 0.5 }}>
            <Download size={16} /> Export CSV
          </button>
          <button type="button" disabled={!data} onClick={exportPdf} className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 cursor-pointer font-semibold" style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}`, opacity: data ? 1 : 0.5 }}>
            <FileText size={16} /> PDF statement
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {data && rows.length === 0 && (
            <div className="text-sm mt-6 text-center" style={{ color: MUTED }}>
              No transactions in this period.
            </div>
          )}
          {rows.slice(0, shown).map((r) => (
            <Row key={r.txid} r={r} />
          ))}
          {rows.length > shown && (
            <button type="button" onClick={() => setShown((n) => n + 200)} className="py-2 bg-transparent border-0 cursor-pointer text-sm" style={{ color: GOLD }}>
              Show more ({rows.length - shown} left)
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

const Row = ({ r }: { r: HistoryRow }) => {
  const Icon = r.direction === 'in' ? ArrowDownLeft : r.direction === 'out' ? ArrowUpRight : Repeat;
  const color = r.direction === 'in' ? GREEN : r.direction === 'out' ? RED : MUTED;
  const usd = usdValue(r);
  return (
    <div className="rounded-xl p-3 flex gap-3" style={{ background: CARD }}>
      <div className="mt-1" style={{ color }}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between gap-2">
          <span className="text-sm font-semibold capitalize">{r.label}</span>
          <span className="text-sm font-semibold" style={{ color }}>
            {r.amountSats > 0 ? '+' : ''}
            {fmtBsv(r.amountSats)}
          </span>
        </div>
        <div className="flex justify-between gap-2 text-xs" style={{ color: MUTED }}>
          <span>{new Date(r.time).toLocaleString()}</span>
          <span>
            {fmtSats(r.amountSats)}
            {usd ? ` · $${usd}${r.usdRateIsCurrent ? ' (current rate)' : ''}` : ''}
          </span>
        </div>
        {(r.feeSats > 0 || r.counterparty || r.note) && (
          <div className="text-xs mt-1 break-all" style={{ color: MUTED }}>
            {r.feeSats > 0 && <span>Fee {fmtSats(r.feeSats)} </span>}
            {r.counterparty && <span>· {r.direction === 'in' ? 'from' : 'to'} {r.counterparty} </span>}
            {r.note && <span>· {r.note}</span>}
          </div>
        )}
        <a
          href={`https://whatsonchain.com/tx/${r.txid}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs inline-flex items-center gap-1 mt-1 font-mono"
          style={{ color: GOLD }}
        >
          {r.txid.slice(0, 12)}…{r.txid.slice(-6)} <ExternalLink size={11} />
          {r.confirmations === 0 && <span style={{ color: MUTED }}> · unconfirmed</span>}
        </a>
      </div>
    </div>
  );
};

export default HistoryScreen;
