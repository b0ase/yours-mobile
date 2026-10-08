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
import {
  fetchAccountTxs,
  fetchDailyRates,
  fetchLocalInfo,
  fetchTokenSymbols,
  fetchTxs,
  type Progress,
} from './txHistoryFetch';
import {
  CATEGORIES,
  assetText,
  classifyEvent,
  filterCategory,
  findListings,
  historyLooksIncomplete,
  type Category,
} from './historyEvents';
import { missingParents, ownOutputs, type RawTx } from './txHistory';
import { loadLastBalance } from './balanceLoad';
import { appsByTxid, loadConnectionLog } from './connectionLog';
import { ConnectionsView } from './ConnectionsView';
import { GainsView } from './GainsView';
import { cacheBsvUsd } from './fiatRates';
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
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [view, setView] = useState<'tx' | 'connections' | 'gains'>('tx');

  const load = useCallback(async () => {
    setError('');
    setProgress({ phase: 'Starting', done: 0, total: 1 });
    try {
      const key = apiContext.wocApiKey || undefined;
      const [local, connLog] = await Promise.all([
        fetchLocalInfo(apiContext.wallet?.listActions?.bind(apiContext.wallet) as Parameters<typeof fetchLocalInfo>[0]),
        loadConnectionLog(),
      ]);
      // The wallet's own action log adds txs the address index can miss (inscription outputs).
      const txs = await fetchAccountTxs(addresses, key, setProgress, local.keys());
      // Pots and agent accounts: unlabelled outgoing payments are pot payments / agent spend.
      const kind = getAgentAccount(addrs?.identityAddress)?.kind;
      const now = Date.now();
      const own = new Set(addresses);
      // Wallet-funded txs spend coins on the wallet's derived keys: load those parents for the fee.
      const parents = missingParents(txs, local as Map<string, LocalInfo>);
      const extra = new Map<string, number>();
      if (parents.length) {
        setProgress({ phase: 'Fees', done: 0, total: parents.length });
        for (const t of await fetchTxs(parents.slice(0, 2000), key))
          for (const o of t.vout) extra.set(`${t.txid}:${o.n}`, o.sats);
      }
      let rows = buildRows(txs, own, local as Map<string, LocalInfo>, now, extra);
      if (kind)
        rows = rows.map((r) =>
          r.direction === 'out' && r.label === 'send'
            ? { ...r, label: kind === 'pot' ? 'pot payment' : 'agent spend' }
            : r,
        );
      // History v2: token / NFT / game / subscription / app events (historyEvents.ts).
      const byId = new Map<string, RawTx>(txs.map((t) => [t.txid, t]));
      const prev = ownOutputs([...byId.values()], own);
      const ctx = {
        own,
        prev,
        listings: findListings([...byId.values()], prev),
        appByTxid: appsByTxid(connLog),
        accountKind: kind,
      };
      rows = rows.map((r) => classifyEvent(r, byId.get(r.txid), local.get(r.txid), ctx));
      // Txs only the action log knew about that move nothing on these addresses (BRC-100 derived keys) are noise here.
      rows = rows.filter((r) => r.amountSats !== 0 || r.feeSats !== 0 || r.asset || r.direction === 'self');
      setProgress({ phase: 'Token names', done: 0, total: 1 });
      // Symbols and decimals (so "89131856" reads "0.89131856", as in the token list).
      const ids = [...new Set(rows.map((r) => (r.asset?.kind === 'token' ? r.asset.id : '')).filter(Boolean))];
      const syms = ids.length ? await fetchTokenSymbols(ids) : new Map<string, { sym?: string; dec?: number }>();
      if (syms.size)
        rows = rows.map((r) => {
          const t = r.asset ? syms.get(r.asset.id) : undefined;
          return r.asset && t
            ? { ...r, asset: { ...r.asset, symbol: r.asset.symbol ?? t.sym, dec: r.asset.dec ?? t.dec } }
            : r;
        });
      setProgress({ phase: 'Prices', done: 1, total: 1 });
      const oldest = rows.length ? Math.min(...rows.map((r) => r.time)) : now;
      const [daily, current] = await Promise.all([
        fetchDailyRates(Math.floor(oldest / 1000) - 86400, Math.floor(now / 1000), key),
        fetchExchangeRate(apiContext.chain, apiContext.wocApiKey).catch(() => 0),
      ]);
      // Daily BSV/USD is cached on the device, so a failed price fetch still has the days seen before.
      setData({ rows: withRates(rows, cacheBsvUsd(ratesByDay(daily)), current), at: now });
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
  const rows = useMemo(
    () =>
      data ? filterCategory(filterRange(data.rows, range) as (HistoryRow & { category: Category })[], category) : [],
    [data, range, category],
  );
  const sum = totals(rows);
  const bal = data ? balances(data.rows, range) : null;
  // Only a range that runs to now can be checked against the wallet's balance.
  const incomplete =
    !!data &&
    historyLooksIncomplete(
      sum,
      range.to === null || range.to >= data.at - 60_000 ? (bal?.closing ?? null) : null,
      category === 'all' ? loadLastBalance(addrs?.identityAddress) : null,
    );
  const stem = fileStem(accountName, range);

  const exportCsv = () => void saveTextFile(`${stem}.csv`, toCsv(rows, accountName), 'text/csv;charset=utf-8');
  const exportPdf = () => {
    const html = statementHtml({
      account: accountName,
      addresses,
      range,
      rows,
      // A category-filtered statement has no meaningful account balance.
      opening: category === 'all' ? (bal?.opening ?? null) : null,
      closing: category === 'all' ? (bal?.closing ?? null) : null,
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
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="p-2 bg-transparent border-0 cursor-pointer"
          style={{ color: '#fff' }}
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex gap-2 px-4 pt-3" role="tablist" aria-label="History view">
        {(
          [
            ['tx', 'Transactions'],
            ['gains', 'Gains'],
            ['connections', 'Connections'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className="flex-1 py-2 rounded-xl text-sm font-semibold border-0 cursor-pointer"
            style={{ background: view === id ? '#fff' : CARD, color: view === id ? '#000' : '#fff' }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'connections' ? (
        <ConnectionsView rows={data?.rows ?? []} />
      ) : view === 'gains' ? (
        <GainsView rows={data?.rows ?? []} account={accountName} />
      ) : (
        <div
          className="flex-1 overflow-y-auto px-4 pb-8"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}
        >
          {progress && (
            <div className="mt-4" aria-live="polite">
              <div className="text-xs mb-1" style={{ color: MUTED }}>
                Loading full history… {progress.phase}
                {progress.total > 1 ? ` (${progress.done}/${progress.total})` : ''}
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: LINE }}>
                <div
                  className="h-full"
                  style={{ width: `${Math.max(4, pct)}%`, background: GOLD, transition: 'width .3s' }}
                />
              </div>
            </div>
          )}
          {error && (
            <div className="mt-4 text-sm" style={{ color: RED }}>
              {error}{' '}
              <button
                type="button"
                onClick={() => void load()}
                className="underline bg-transparent border-0"
                style={{ color: GOLD }}
              >
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
          <div className="flex gap-2 mt-2 overflow-x-auto pb-1" role="group" aria-label="Category">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={category === c.id}
                onClick={() => {
                  setCategory(c.id);
                  setShown(100);
                }}
                className="px-3 py-1 rounded-full text-xs cursor-pointer whitespace-nowrap"
                style={{
                  background: category === c.id ? '#fff' : 'transparent',
                  color: category === c.id ? '#000' : MUTED,
                  border: `1px solid ${category === c.id ? '#fff' : LINE}`,
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex gap-2 mt-2 text-xs items-center" style={{ color: MUTED }}>
              <label className="flex flex-col gap-1">
                From
                <input
                  type="date"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="rounded px-2 py-1"
                  style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }}
                />
              </label>
              <label className="flex flex-col gap-1">
                To
                <input
                  type="date"
                  value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="rounded px-2 py-1"
                  style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}` }}
                />
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
          {incomplete && (
            <div
              role="status"
              className="text-xs mt-2 rounded-lg p-2"
              style={{ color: GOLD, border: `1px solid ${GOLD}` }}
            >
              History may be incomplete. Pull to refresh or run Repair Sync (Settings &gt; Troubleshooting).
            </div>
          )}
          {bal && (
            <div className="text-xs mt-2" style={{ color: MUTED }}>
              {sum.count} transactions
              {/* Opening / closing are for the whole account, so only beside the unfiltered list. */}
              {category === 'all' && ` · opening ${fmtBsv(bal.opening)} · closing ${fmtBsv(bal.closing)}`}
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              disabled={!data}
              onClick={exportCsv}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 border-0 cursor-pointer font-semibold"
              style={{ background: GOLD, color: '#000', opacity: data ? 1 : 0.5 }}
            >
              <Download size={16} /> Export CSV
            </button>
            <button
              type="button"
              disabled={!data}
              onClick={exportPdf}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 cursor-pointer font-semibold"
              style={{ background: CARD, color: '#fff', border: `1px solid ${LINE}`, opacity: data ? 1 : 0.5 }}
            >
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
              <button
                type="button"
                onClick={() => setShown((n) => n + 200)}
                className="py-2 bg-transparent border-0 cursor-pointer text-sm"
                style={{ color: GOLD }}
              >
                Show more ({rows.length - shown} left)
              </button>
            )}
          </div>
        </div>
      )}
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
        {(r.asset || r.app || r.appNote) && (
          <div className="text-xs mt-1 break-all" style={{ color: '#fff' }}>
            {r.asset && <span>{assetText(r.asset)} </span>}
            {r.app && (
              <span style={{ color: MUTED }}>
                {r.asset ? '· ' : ''}via {r.app}
              </span>
            )}
            {r.appNote && (
              <span>
                {r.asset || r.app ? ' · ' : ''}“{r.appNote}”
              </span>
            )}
          </div>
        )}
        {(r.feeSats > 0 || r.counterparty || r.note) && (
          <div className="text-xs mt-1 break-all" style={{ color: MUTED }}>
            {r.feeSats > 0 && <span>Fee {fmtSats(r.feeSats)} </span>}
            {r.counterparty && (
              <span>
                · {r.direction === 'in' ? 'from' : 'to'} {r.counterparty}{' '}
              </span>
            )}
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
