/**
 * One request waiting on partners (a shared account payment or a Partnership shares move): what it does, to whom,
 * how much, the rule, who has approved and who hasn't, and the buttons that apply to this partner. The facts shown
 * are the ones the caller computed from the transaction (accountRules.checkAccountProposal / the share plan).
 */
import type { ReactNode } from 'react';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const btn = 'rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50';

export type ApprovalStatus = 'needs-you' | 'waiting' | 'ready' | 'sent';

const STATUS: Record<ApprovalStatus, string> = {
  'needs-you': 'Your approval needed',
  waiting: 'Waiting for partners',
  ready: 'Approved · ready to send',
  sent: 'Sent',
};

export function ApprovalCard(p: {
  what: string;
  to?: string;
  amount?: string;
  fee?: string;
  rule: string;
  signed: string[];
  waiting: string[];
  status: ApprovalStatus;
  busy: boolean;
  onApprove?: () => void;
  onDecline?: () => void;
  onSend?: () => void;
  extra?: ReactNode;
}) {
  const row = (k: string, v?: string) =>
    v ? (
      <div className="flex gap-2 text-xs">
        <span className="w-20 shrink-0" style={{ color: MUTED }}>
          {k}
        </span>
        <span className="text-white break-all">{v}</span>
      </div>
    ) : null;
  return (
    <div className="rounded-xl bg-[#101216] p-3 flex flex-col gap-1.5" role="group" aria-label={p.what}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-white font-bold">{p.what}</span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={
            p.status === 'needs-you'
              ? { background: GOLD, color: '#1a1300' }
              : { background: '#2b2f36', color: p.status === 'ready' ? GOLD : MUTED }
          }
        >
          {STATUS[p.status]}
        </span>
      </div>
      {row('To', p.to)}
      {row('Amount', p.amount)}
      {row('Network fee', p.fee)}
      {row('Rule', p.rule)}
      {row('Approved', p.signed.length ? p.signed.join(', ') : 'Nobody yet')}
      {p.status !== 'sent' && row('Waiting on', p.waiting.join(', '))}
      {(p.onApprove || p.onDecline || p.onSend || p.extra) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {p.onApprove && (
            <button
              type="button"
              disabled={p.busy}
              onClick={p.onApprove}
              className={btn}
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Approve
            </button>
          )}
          {p.onSend && (
            <button
              type="button"
              disabled={p.busy}
              onClick={p.onSend}
              className={btn}
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Send to the network
            </button>
          )}
          {p.onDecline && (
            <button
              type="button"
              disabled={p.busy}
              onClick={p.onDecline}
              className={btn}
              style={{ background: '#2b2f36', color: '#fff' }}
            >
              Decline
            </button>
          )}
          {p.extra}
        </div>
      )}
    </div>
  );
}
