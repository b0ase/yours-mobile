import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { saveTextFile } from '../agents/saveText';
import { myKey } from '../bmail/client';
import { loadMail } from '../bmail/store';
import { resolveCallee } from '../calls/peer';
import { isNative } from '../native';
import { parseUsdInput, useBsvUsd } from '../money/money';
import { disputeLine, payWorker, refreshWages } from './api';
import {
  closeDispute,
  disputeLines,
  payCsv,
  payStatementHtml,
  periods,
  totalsOf,
  usd,
  type Ledger,
  type PeriodView,
} from './ledger';
import { centsToSats, type PayStatement } from './statement';
import { loadWages, saveWages, WAGES_EVENT } from './store';

const btn = 'px-3 py-2 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';
const gold = { background: 'var(--bw-accent-hi)', color: '#000' };
const dark = { background: '#2b2f36', color: '#fff' };
const muted = { color: 'var(--bw-muted, #98a2b3)' };
const field = 'w-full mt-1 rounded-lg p-2 text-xs';
const fieldStyle = { background: 'var(--bw-bg)', color: '#fff', border: '1px solid #2b2f36' };
const cents = (s: string) => {
  const n = s.trim() === '' || s.trim() === '0' ? 0 : parseUsdInput(s);
  return n === null ? null : Math.round(n * 100);
};
const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Settings › Pay: wage statements. A business account pays a worker with a signed statement; the worker sees each
 * pay period with what was received, what is pending and what is disputed, and who acts next.
 */
export const WagesScreen = () => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext?.wallet;
  const [me, setMe] = useState('');
  const [tab, setTab] = useState<'list' | 'pay'>('list');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (wallet) void myKey(wallet).then(setMe);
  }, [wallet]);
  useEffect(() => {
    if (!me) return;
    const on = () => setLedger(loadWages(me).ledger);
    on();
    window.addEventListener(WAGES_EVENT, on);
    return () => window.removeEventListener(WAGES_EVENT, on);
  }, [me]);
  const views = useMemo(() => (ledger ? periods(ledger) : []), [ledger]);
  const mine = views.filter((v) => v.statement.worker === me);
  const paid = views.filter((v) => v.statement.payer === me);

  const refresh = useCallback(async () => {
    if (!wallet || !me) return;
    setBusy(true);
    setMsg('');
    try {
      await refreshWages(wallet, loadMail(me).received);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not refresh');
    } finally {
      setBusy(false);
    }
  }, [wallet, me]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!wallet || !ledger)
    return (
      <p className="text-xs" style={muted}>
        Unlock your wallet first.
      </p>
    );
  const exportCsv = () => void saveTextFile('bwallet-pay.csv', payCsv(ledger), 'text/csv;charset=utf-8');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <button type="button" className={btn} style={tab === 'list' ? gold : dark} onClick={() => setTab('list')}>
          Statements
        </button>
        <button type="button" className={btn} style={tab === 'pay' ? gold : dark} onClick={() => setTab('pay')}>
          Pay a worker
        </button>
        <button type="button" className={btn} style={dark} disabled={busy} onClick={() => void refresh()}>
          {busy ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      {tab === 'pay' ? (
        <PayForm onDone={() => setTab('list')} />
      ) : (
        <>
          <Section title="Paid to me" views={mine} role="worker" />
          <Section title="Paid by me" views={paid} role="payer" />
          {views.length > 0 && (
            <button type="button" className={`${btn} self-start`} style={dark} onClick={exportCsv}>
              Export CSV
            </button>
          )}
          {!views.length && (
            <p className="text-[11px] m-0" style={muted}>
              No pay statements yet. When someone pays you with a statement, it shows here.
            </p>
          )}
        </>
      )}
      {msg && (
        <p className="text-[11px] m-0" style={{ color: '#F97066' }}>
          {msg}
        </p>
      )}
    </div>
  );
};

const Section = ({ title, views, role }: { title: string; views: PeriodView[]; role: 'worker' | 'payer' }) => {
  if (!views.length) return null;
  const t = totalsOf(views);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold">{title}</div>
      <div className="text-[11px]" style={muted}>
        {role === 'worker' ? 'Received' : 'Confirmed'} {usd(t.receivedCents)} · Pending {usd(t.pendingCents)} · Disputed{' '}
        {usd(t.disputedCents)} · Still owed {usd(t.outstandingCents)}
      </div>
      {views.map((v) => (
        <PeriodCard key={v.statement.id} v={v} role={role} />
      ))}
    </div>
  );
};

const PeriodCard = ({ v, role }: { v: PeriodView; role: 'worker' | 'payer' }) => {
  const { apiContext } = useServiceContext();
  const [open, setOpen] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const s = v.statement;
  const pdf = () => {
    const html = payStatementHtml(v, !isNative);
    if (!isNative) {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const w = window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (w) return;
    }
    void saveTextFile(`pay-${s.period.start}-${s.period.end}.html`, html, 'text/html');
  };
  const close = async (id: string) => {
    if (!apiContext) return;
    const me = await myKey(apiContext.wallet);
    const st = loadWages(me);
    saveWages(me, { ...st, ledger: closeDispute(st.ledger, id) });
  };
  return (
    <div className="rounded-lg p-3 flex flex-col gap-1" style={{ background: '#17191E' }}>
      <button
        type="button"
        className="bg-transparent border-0 p-0 text-left cursor-pointer text-white"
        onClick={() => setOpen(!open)}
      >
        <div className="text-sm font-semibold">
          {s.period.start} to {s.period.end} · {usd(v.dueCents)}
        </div>
        <div className="text-[11px]" style={muted}>
          {role === 'worker' ? s.payerName || 'Payer' : s.workerPaymail} · Received {usd(v.receivedCents)} · Pending{' '}
          {usd(v.pendingCents + v.uncertainCents)}
          {v.disputedCents ? ` · Disputed ${usd(v.disputedCents)}` : ''}
          {s.replaces ? ' · Corrected' : ''}
        </div>
        <div className="text-[11px]" style={{ color: v.next === 'nobody' ? '#32D583' : '#F5B800' }}>
          {v.nextText}
        </div>
      </button>
      {open && (
        <div className="flex flex-col gap-1 text-[11px]">
          <div>Gross pay {usd(s.grossCents)}</div>
          {s.deductions.map((d, i) => (
            <div key={i}>
              {d.label} −{usd(d.cents)} <span style={muted}>({d.basis})</span>
            </div>
          ))}
          <div className="font-semibold">Net pay {usd(s.netCents)}</div>
          {s.note && <div style={muted}>{s.note}</div>}
          {v.payments.map((p) => (
            <div key={p.txid} style={muted}>
              Payment {p.sats.toLocaleString('en-US')} sats ·{' '}
              {p.status === 'uncertain' ? 'could not be checked' : p.status}
            </div>
          ))}
          {v.history.length > 0 && <div style={muted}>Earlier versions kept: {v.history.length}</div>}
          {v.disputes.map((d) => (
            <div key={d.id}>
              Dispute: {disputeLines(s).find((x) => x.line === d.line)?.label ?? d.line} {usd(d.cents)} · {d.state} ·{' '}
              <span style={muted}>{d.reason}</span>
              {role === 'worker' && d.state !== 'closed' && (
                <button type="button" className={`${btn} ml-2`} style={dark} onClick={() => void close(d.id)}>
                  {d.state === 'answered' ? 'Accept correction' : 'Withdraw'}
                </button>
              )}
            </div>
          ))}
          <div className="flex gap-2 flex-wrap mt-1">
            {role === 'worker' && (
              <button type="button" className={btn} style={dark} onClick={() => setDisputing(!disputing)}>
                Dispute a line
              </button>
            )}
            {role === 'payer' && (
              <button type="button" className={btn} style={dark} onClick={() => setCorrecting(!correcting)}>
                Send a correction
              </button>
            )}
            <button type="button" className={btn} style={dark} onClick={pdf}>
              PDF
            </button>
          </div>
          {disputing && <DisputeForm s={s} onDone={() => setDisputing(false)} />}
          {correcting && <PayForm original={s} onDone={() => setCorrecting(false)} />}
        </div>
      )}
    </div>
  );
};

const DisputeForm = ({ s, onDone }: { s: PayStatement; onDone: () => void }) => {
  const { apiContext } = useServiceContext();
  const lines = disputeLines(s);
  const [line, setLine] = useState(lines[0].line);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go = async () => {
    if (!apiContext) return;
    const c = amount.trim() ? cents(amount) : (lines.find((l) => l.line === line)?.cents ?? 0);
    if (c === null) return setMsg('Enter an amount like 12.50');
    setBusy(true);
    setMsg('');
    try {
      await disputeLine(apiContext.wallet, s, { line, cents: c, reason });
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send the dispute');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 mt-1">
      <select value={line} onChange={(e) => setLine(e.target.value)} className={field} style={fieldStyle}>
        {lines.map((l) => (
          <option key={l.line} value={l.line}>
            {l.label} ({usd(l.cents)})
          </option>
        ))}
      </select>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount in dispute, USD (blank = the whole line)"
        className={field}
        style={fieldStyle}
      />
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What is wrong with this line?"
        className={`${field} min-h-[60px]`}
        style={fieldStyle}
      />
      <button type="button" className={`${btn} self-start`} style={gold} disabled={busy} onClick={() => void go()}>
        {busy ? 'Sending…' : 'Sign and send dispute'}
      </button>
      {msg && (
        <p className="text-[11px] m-0" style={{ color: '#F97066' }}>
          {msg}
        </p>
      )}
    </div>
  );
};

type Row = { label: string; amount: string; basis: string };

/** New statement, or (with `original`) a correction that references it. */
const PayForm = ({ original, onDone }: { original?: PayStatement; onDone: () => void }) => {
  const { apiContext } = useServiceContext();
  const rate = useBsvUsd();
  const [to, setTo] = useState(original?.workerPaymail ?? '');
  const [payerName, setPayerName] = useState(original?.payerName ?? '');
  const [start, setStart] = useState(original?.period.start ?? '');
  const [end, setEnd] = useState(original?.period.end ?? '');
  const [gross, setGross] = useState(original ? (original.grossCents / 100).toFixed(2) : '');
  const [rows, setRows] = useState<Row[]>(
    original?.deductions.map((d) => ({ label: d.label, amount: (d.cents / 100).toFixed(2), basis: d.basis })) ?? [],
  );
  const [note, setNote] = useState('');
  const [send, setSend] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const g = cents(gross);
  const ds = rows.map((r) => cents(r.amount));
  const net = g !== null && ds.every((d) => d !== null) ? g - ds.reduce<number>((a, d) => a + (d ?? 0), 0) : null;
  // A correction sends only the difference still owed (never less than nothing).
  const sendCents = send.trim() ? cents(send) : net !== null && original ? Math.max(0, net - original.netCents) : net;

  const go = async () => {
    if (!apiContext || g === null || net === null || sendCents === null) return setMsg('Check the amounts.');
    setBusy(true);
    setMsg('');
    try {
      const peer = original ? { key: original.worker } : await resolveCallee(f, to.trim());
      const paySats = centsToSats(sendCents, rate);
      await payWorker(apiContext.wallet, {
        payerName,
        worker: peer.key,
        workerPaymail: to.trim(),
        period: { start, end },
        grossCents: g,
        deductions: rows.map((r, i) => ({ label: r.label, cents: ds[i] ?? 0, basis: r.basis })),
        note,
        usdPerBsv: rate,
        paySats,
        ...(original ? { replaces: original.id } : {}),
      });
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };
  const set = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] m-0" style={muted}>
        {original
          ? 'A correction is a new signed statement. The original stays as it was.'
          : 'Sign a pay statement and send the net pay with it. The statement goes by encrypted bMail and only the worker can read it.'}
      </p>
      <label className="text-[11px]" style={muted}>
        Worker ($handle or paymail)
        <input
          value={to}
          disabled={!!original}
          onChange={(e) => setTo(e.target.value)}
          className={field}
          style={fieldStyle}
        />
      </label>
      <label className="text-[11px]" style={muted}>
        Paid by (your business name)
        <input value={payerName} onChange={(e) => setPayerName(e.target.value)} className={field} style={fieldStyle} />
      </label>
      <div className="flex gap-2">
        <label className="text-[11px] flex-1" style={muted}>
          Period start
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={field}
            style={fieldStyle}
          />
        </label>
        <label className="text-[11px] flex-1" style={muted}>
          Period end
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={field}
            style={fieldStyle}
          />
        </label>
      </div>
      <label className="text-[11px]" style={muted}>
        Gross pay (USD)
        <input
          value={gross}
          onChange={(e) => setGross(e.target.value)}
          inputMode="decimal"
          className={field}
          style={fieldStyle}
        />
      </label>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1 rounded-lg p-2" style={{ border: '1px solid #2b2f36' }}>
          <input
            value={r.label}
            onChange={(e) => set(i, 'label', e.target.value)}
            placeholder="Deduction, e.g. Platform fee"
            className={field}
            style={fieldStyle}
          />
          <input
            value={r.amount}
            onChange={(e) => set(i, 'amount', e.target.value)}
            placeholder="Amount (USD)"
            inputMode="decimal"
            className={field}
            style={fieldStyle}
          />
          <input
            value={r.basis}
            onChange={(e) => set(i, 'basis', e.target.value)}
            placeholder="Basis, e.g. 10% of gross"
            className={field}
            style={fieldStyle}
          />
          <button
            type="button"
            className={`${btn} self-start`}
            style={dark}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className={`${btn} self-start`}
        style={dark}
        onClick={() => setRows([...rows, { label: '', amount: '', basis: '' }])}
      >
        Add a deduction
      </button>
      <label className="text-[11px]" style={muted}>
        Note to the worker
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`${field} min-h-[50px]`}
          style={fieldStyle}
        />
      </label>
      <div className="text-xs font-semibold">Net pay {net === null ? '…' : usd(net)}</div>
      <label className="text-[11px]" style={muted}>
        Send now (USD, blank = {original ? 'the difference still owed' : 'the full net'})
        <input
          value={send}
          onChange={(e) => setSend(e.target.value)}
          inputMode="decimal"
          className={field}
          style={fieldStyle}
        />
      </label>
      <button
        type="button"
        className={`${btn} self-start`}
        style={gold}
        disabled={busy || !rate}
        onClick={() => void go()}
      >
        {busy ? 'Sending…' : `Sign and send ${sendCents === null ? '' : usd(sendCents)}`}
      </button>
      {msg && (
        <p className="text-[11px] m-0" style={{ color: '#F97066' }}>
          {msg}
        </p>
      )}
    </div>
  );
};
