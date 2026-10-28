import { csvField, BOM } from '../wallet/txHistory';
import { lineCents, lineLabel, type PayDispute, type PayStatement } from './statement';

/**
 * Pay ledger (pure): statements, the payments allocated to them, disputes. Used by both sides; `me` decides the role.
 *
 * Rules (brief HWPE §5):
 * - A payment (one txid) is allocated to exactly one statement, the first one it arrived with. A duplicate or late
 *   notice for the same txid never allocates it again (not to the same statement, not to another one). A later notice
 *   may only raise its status: uncertain → pending → confirmed.
 * - A correction is a new statement with `replaces`; the original stays as it was. What is due for the period is the
 *   newest statement in the chain; payments to every statement in the chain count towards it.
 * - A payment never closes a dispute. A dispute is open until a correction answers it, and only the worker closes it.
 */
export type PaymentStatus = 'uncertain' | 'pending' | 'confirmed';
export type Payment = { txid: string; sats: number; statementId: string; status: PaymentStatus; at: number };
export type DisputeState = PayDispute & { state: 'open' | 'answered' | 'closed'; answeredBy?: string };
export type Ledger = { statements: PayStatement[]; payments: Payment[]; disputes: DisputeState[] };

export const emptyLedger = (): Ledger => ({ statements: [], payments: [], disputes: [] });

const RANK: Record<PaymentStatus, number> = { uncertain: 0, pending: 1, confirmed: 2 };

/** Add a statement (ignored if already held). A correction marks open disputes on what it replaces as answered. */
export const addStatement = (l: Ledger, s: PayStatement): Ledger => {
  if (l.statements.some((x) => x.id === s.id)) return l;
  const chain = s.replaces ? chainIds(l, s.replaces) : new Set<string>();
  return {
    ...l,
    statements: [...l.statements, s],
    disputes: l.disputes.map((d) =>
      d.state === 'open' && chain.has(d.statementId) ? { ...d, state: 'answered', answeredBy: s.id } : d,
    ),
  };
};

/**
 * A payment notice. Returns the ledger unchanged for a duplicate, a notice that names another statement for an
 * already-allocated txid, or an unknown statement. A known txid's status can only go up.
 */
export const notePayment = (l: Ledger, p: Payment): Ledger => {
  if (!l.statements.some((s) => s.id === p.statementId)) return l;
  const prior = l.payments.find((x) => x.txid === p.txid);
  if (!prior) return { ...l, payments: [...l.payments, p] };
  if (prior.statementId !== p.statementId || RANK[p.status] <= RANK[prior.status]) return l;
  return { ...l, payments: l.payments.map((x) => (x.txid === p.txid ? { ...x, status: p.status } : x)) };
};

export const setPaymentStatus = (l: Ledger, txid: string, status: PaymentStatus): Ledger => {
  const p = l.payments.find((x) => x.txid === txid);
  return p ? notePayment(l, { ...p, status }) : l;
};

export const addDispute = (l: Ledger, d: PayDispute): Ledger => {
  const s = l.statements.find((x) => x.id === d.statementId);
  if (!s || s.worker !== d.worker || l.disputes.some((x) => x.id === d.id)) return l;
  // A correction may already be here (it arrived first): then the dispute is already answered.
  const fix = l.statements.find((x) => x.replaces && chainIds(l, x.replaces).has(d.statementId));
  return {
    ...l,
    disputes: [...l.disputes, fix ? { ...d, state: 'answered', answeredBy: fix.id } : { ...d, state: 'open' }],
  };
};

/** Only the worker closes a dispute (after reading the correction, or to withdraw it). */
export const closeDispute = (l: Ledger, id: string): Ledger => ({
  ...l,
  disputes: l.disputes.map((d) => (d.id === id ? { ...d, state: 'closed' } : d)),
});

/** The statement ids in a chain, walking `replaces` back from `id`. */
const chainIds = (l: Ledger, id: string): Set<string> => {
  const out = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !out.has(cur)) {
    out.add(cur);
    cur = l.statements.find((s) => s.id === cur)?.replaces;
  }
  return out;
};

/** Newest statement that corrects `s` (or `s` itself). */
const latestOf = (l: Ledger, s: PayStatement): PayStatement => {
  let cur = s;
  for (;;) {
    const next = l.statements
      .filter((x) => x.replaces === cur.id)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
    if (!next) return cur;
    cur = next;
  }
};

export type Actor = 'payer' | 'worker' | 'network' | 'nobody';

export type PeriodView = {
  /** The statement that is current for the period (newest correction). */
  statement: PayStatement;
  /** Earlier versions, oldest first (never changed). */
  history: PayStatement[];
  payments: Payment[];
  dueCents: number;
  receivedCents: number;
  pendingCents: number;
  uncertainCents: number;
  disputedCents: number;
  outstandingCents: number;
  disputes: DisputeState[];
  next: Actor;
  nextText: string;
};

/** Payment sats → cents at the statement's own rate (net sats ↔ net cents). */
const satsToCents = (sats: number, s: PayStatement) =>
  s.netSats > 0 ? Math.round((sats * s.netCents) / s.netSats) : 0;

/** One row per pay period chain (an original plus its corrections), newest period first. */
export const periods = (l: Ledger): PeriodView[] => {
  const roots = l.statements.filter((s) => !s.replaces || !l.statements.some((x) => x.id === s.replaces));
  return roots
    .map((root) => {
      const latest = latestOf(l, root);
      const ids = chainIds(l, latest.id);
      const history = l.statements.filter((s) => ids.has(s.id) && s.id !== latest.id);
      history.sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
      const payments = l.payments.filter((p) => ids.has(p.statementId));
      const byStatus = (st: PaymentStatus) =>
        payments
          .filter((p) => p.status === st)
          .reduce((a, p) => a + satsToCents(p.sats, l.statements.find((s) => s.id === p.statementId) ?? latest), 0);
      const receivedCents = byStatus('confirmed');
      const pendingCents = byStatus('pending');
      const uncertainCents = byStatus('uncertain');
      const disputes = l.disputes.filter((d) => ids.has(d.statementId));
      const live = disputes.filter((d) => d.state !== 'closed');
      const disputedCents = live.reduce((a, d) => a + d.cents, 0);
      const dueCents = latest.netCents;
      const outstandingCents = Math.max(0, dueCents - receivedCents - pendingCents - uncertainCents);
      const [next, nextText] = nextActor({ live, uncertainCents, pendingCents, outstandingCents });
      return {
        statement: latest,
        history,
        payments,
        dueCents,
        receivedCents,
        pendingCents,
        uncertainCents,
        disputedCents,
        outstandingCents,
        disputes,
        next,
        nextText,
      };
    })
    .sort((a, b) => b.statement.period.start.localeCompare(a.statement.period.start));
};

const nextActor = (v: {
  live: DisputeState[];
  uncertainCents: number;
  pendingCents: number;
  outstandingCents: number;
}): [Actor, string] => {
  if (v.live.some((d) => d.state === 'open')) return ['payer', 'The payer needs to answer the dispute'];
  if (v.live.some((d) => d.state === 'answered')) return ['worker', 'The worker needs to review the correction'];
  if (v.uncertainCents > 0) return ['payer', 'The payer needs to check a payment that could not be confirmed'];
  if (v.outstandingCents > 0) return ['payer', 'The payer still owes part of this period'];
  if (v.pendingCents > 0) return ['network', 'Waiting for the network to confirm the payment'];
  return ['nobody', 'Paid in full'];
};

export type Totals = { receivedCents: number; pendingCents: number; disputedCents: number; outstandingCents: number };
export const totalsOf = (vs: PeriodView[]): Totals =>
  vs.reduce(
    (a, v) => ({
      receivedCents: a.receivedCents + v.receivedCents,
      pendingCents: a.pendingCents + v.pendingCents + v.uncertainCents,
      disputedCents: a.disputedCents + v.disputedCents,
      outstandingCents: a.outstandingCents + v.outstandingCents,
    }),
    { receivedCents: 0, pendingCents: 0, disputedCents: 0, outstandingCents: 0 },
  );

export const usd = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

export const PAY_CSV_COLUMNS = [
  'period_start',
  'period_end',
  'statement_id',
  'replaces',
  'payer',
  'payer_key',
  'worker_paymail',
  'line',
  'label',
  'amount_usd',
  'basis',
  'status',
  'txid',
  'sats',
] as const;

/** CSV, one row per line (gross, each deduction, net), payment and dispute, every statement version included. */
export const payCsv = (l: Ledger): string => {
  const out = [PAY_CSV_COLUMNS.join(',')];
  const row = (s: PayStatement, cols: (string | number)[]) =>
    out.push(
      [s.period.start, s.period.end, s.id, s.replaces ?? '', s.payerName, s.payer, s.workerPaymail, ...cols]
        .map(csvField)
        .join(','),
    );
  for (const v of periods(l)) {
    for (const s of [...v.history, v.statement]) {
      const state = s.id === v.statement.id ? 'current' : 'corrected';
      row(s, ['gross', 'Gross pay', usd(s.grossCents), '', state, '', '']);
      s.deductions.forEach((d, i) => row(s, [`deduction:${i}`, d.label, usd(-d.cents), d.basis, state, '', '']));
      row(s, ['net', 'Net pay', usd(s.netCents), `${s.netSats} sats at $${s.usdPerBsv}/BSV`, state, '', '']);
      for (const p of v.payments.filter((x) => x.statementId === s.id))
        row(s, ['payment', 'Payment', usd(satsToCents(p.sats, s)), '', p.status, p.txid, p.sats]);
      for (const d of v.disputes.filter((x) => x.statementId === s.id))
        row(s, [d.line, `Dispute: ${lineLabel(s, d.line)}`, usd(d.cents), d.reason, `dispute ${d.state}`, '', '']);
    }
  }
  return BOM + out.join('\r\n') + '\r\n';
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A printable page (open it, then Print → Save as PDF), as the history statement does. */
export const payStatementHtml = (v: PeriodView, autoPrint = false): string => {
  const s = v.statement;
  const r = (a: string, b: string, c = '') =>
    `<tr><td>${esc(a)}</td><td style="text-align:right">${esc(b)}</td><td>${esc(c)}</td></tr>`;
  const rows = [
    r('Gross pay', usd(s.grossCents)),
    ...s.deductions.map((d) => r(d.label, usd(-d.cents), d.basis)),
    r('Net pay', usd(s.netCents), `${s.netSats.toLocaleString('en-US')} sats at $${s.usdPerBsv}/BSV`),
  ].join('');
  const pays = v.payments.map((p) => r(`Payment ${p.txid.slice(0, 12)}…`, `${p.sats} sats`, p.status)).join('');
  const disputes = v.disputes
    .map((d) => r(`Dispute: ${lineLabel(s, d.line)}`, usd(d.cents), `${d.state}: ${d.reason}`))
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pay statement ${esc(s.period.start)} to ${esc(
    s.period.end,
  )}</title><style>body{font-family:Helvetica,Arial,sans-serif;margin:32px;color:#111}td{padding:4px 8px;border-bottom:1px solid #ddd;vertical-align:top}table{border-collapse:collapse;width:100%}</style></head><body><h1>Pay statement</h1><p>${esc(
    s.payerName,
  )} to ${esc(s.workerPaymail)}<br>Period ${esc(s.period.start)} to ${esc(s.period.end)}<br>Issued ${esc(s.issuedAt)}${
    s.replaces ? `<br>Corrects statement ${esc(s.replaces)}` : ''
  }</p><table>${rows}${pays}${disputes}</table><p>Received ${usd(v.receivedCents)} · Pending ${usd(
    v.pendingCents + v.uncertainCents,
  )} · Disputed ${usd(v.disputedCents)} · Still owed ${usd(v.outstandingCents)}<br>${esc(v.nextText)}</p>${
    s.note ? `<p>Note: ${esc(s.note)}</p>` : ''
  }<p style="color:#666;font-size:12px">Signed by the payer's identity key ${esc(s.payer)}. Statement ${esc(
    s.id,
  )}.</p>${autoPrint ? '<script>print()</script>' : ''}</body></html>`;
};

/** For the dispute form: each line of a statement and its amount. */
export const disputeLines = (s: PayStatement): { line: string; label: string; cents: number }[] =>
  ['gross', ...s.deductions.map((_, i) => `deduction:${i}`), 'net'].map((line) => ({
    line,
    label: lineLabel(s, line),
    cents: lineCents(s, line) ?? 0,
  }));
