import { useContext, useEffect, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { Check, Clock, Copy } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { ServiceContext } from '../../contexts/ServiceContext';
import { onOutboxChange, outboxText, queuedFor, type QueuedReport } from '../agent/reportOutbox';
import { currentAccountId, retryOutbox, sendOrQueueReport } from '../agent/reportSend';
import { copyError, errorReportText, redactSecrets } from './errorReport';

/**
 * "Copy" and "Ask b" for any error (owner, 10 Oct 2026). Use this (or ErrorNotice) wherever an error is
 * shown, so every error can be copied and taken straight to b. Both actions redact secrets first.
 */
export const ErrorActions = ({
  message,
  color = '#fff',
  onAsk,
}: {
  message: string;
  color?: string;
  onAsk?: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const btn =
    'shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold border-0 cursor-pointer select-none';
  // Error UI can render outside the router (boot errors): the Your reports link only shows inside it.
  const inRouter = useInRouterContext();
  // "Report to b" files the error with the team (bit-sign feedback log) instead of asking b's AI to guess a cause:
  // b once told the owner a broadcast refusal was a one-click-pay limit (17 Oct 2026). The ref comes back here.
  // Plain useContext: error UI also renders outside the provider (boot errors). A report that can't go now is
  // kept in the outbox and sent later (owner 17 Oct: never just vanish; never swapped for Ask b).
  const services = useContext(ServiceContext);
  const apiContext = services?.apiContext;
  const account = currentAccountId(services?.chromeStorageService);
  // null → idle, 'sending' → in flight, { ref } → filed (ref like "F-8", may be empty), { queued } → in the outbox.
  const [sent, setSent] = useState<null | 'sending' | { ref: string } | { queued: QueuedReport; retrying?: boolean }>(
    null,
  );
  const queuedId = sent && typeof sent === 'object' && 'queued' in sent ? sent.queued.id : null;
  // The background runner (or a Retry) sent it: show it as reported.
  useEffect(() => {
    if (!queuedId) return;
    return onOutboxChange(() => {
      const left = queuedFor(account).find((r) => r.id === queuedId);
      if (!left) setSent({ ref: '' });
      else setSent((s) => (s && typeof s === 'object' && 'queued' in s ? { queued: left, retrying: s.retrying } : s));
    });
  }, [queuedId, account]);
  const report = async () => {
    if (sent) return;
    setSent('sending');
    const r = await sendOrQueueReport(apiContext, account, redactSecrets(errorReportText(message)));
    if ('queued' in r) return setSent({ queued: r.queued });
    // Owner 17 Oct: never just vanish. Confirm in its own full-width row, then close.
    setSent({ ref: (r.sent.ref ?? '').replace(/^#/, '') });
    setTimeout(() => onAsk?.(), 8000);
  };
  const retry = async () => {
    if (!sent || typeof sent !== 'object' || !('queued' in sent) || sent.retrying) return;
    setSent({ ...sent, retrying: true });
    await retryOutbox(apiContext, account).catch(() => null);
    setSent((s) => (s && typeof s === 'object' && 'queued' in s ? { ...s, retrying: false } : s));
  };
  if (sent && typeof sent === 'object' && 'queued' in sent) {
    const signin = sent.queued.reason === 'signin';
    return (
      <span
        role="status"
        className="basis-full flex items-start gap-2 rounded-lg px-3 py-2"
        style={{ background: color + '1a' }}
      >
        <Clock size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
        <span className="flex flex-col gap-1 text-xs leading-snug" style={{ color }}>
          <span className="font-semibold">{outboxText(sent.queued.reason)}</span>
          <span>
            Nothing is lost
            {inRouter ? (
              <>
                {' '}
                · it's in <ReportsLink color={color} />.
              </>
            ) : (
              '.'
            )}
          </span>
          {apiContext && (
            <span>
              <button
                type="button"
                className={btn}
                style={{ background: '#F5C542', color: '#0B0A08' }}
                disabled={sent.retrying}
                onClick={() => void retry()}
              >
                {sent.retrying ? 'Sending…' : signin ? 'Sign in to send' : 'Retry'}
              </button>
            </span>
          )}
        </span>
      </span>
    );
  }
  if (sent && sent !== 'sending' && 'ref' in sent)
    return (
      <span
        role="status"
        className="basis-full flex items-start gap-2 rounded-lg px-3 py-2"
        style={{ background: color + '1a' }}
      >
        <Check size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
        <span className="flex flex-col gap-0.5 text-xs leading-snug" style={{ color }}>
          <span className="font-semibold">Reported to b{sent.ref ? ` · Ref ${sent.ref}` : ''}</span>
          <span>
            Sorry about this.{' '}
            {inRouter ? (
              <>
                Follow it in <ReportsLink color={color} />.
              </>
            ) : (
              "We're looking into it."
            )}
          </span>
        </span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        aria-label="Copy error"
        className={btn}
        style={{ background: color + '22', color }}
        onClick={async () => {
          if (await copyError(message)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        aria-label="Report this error to b"
        className={btn}
        style={{ background: '#F5C542', color: '#0B0A08' }}
        disabled={sent === 'sending'}
        onClick={() => report()}
      >
        <img src={bGlyph} alt="" width={12} height={12} />
        {sent === 'sending' ? 'Reporting…' : 'Report to b'}
      </button>
    </span>
  );
};

/** "Your reports" (/m/reports): every report and where it stands. Only rendered inside the router. */
const ReportsLink = ({ color }: { color: string }) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="underline p-0 border-0 bg-transparent cursor-pointer text-xs"
      style={{ color }}
      onClick={() => navigate('/m/reports')}
    >
      Your reports
    </button>
  );
};

/** An inline error card: selectable text plus Copy and Ask b. */
export const ErrorNotice = ({ message, className = '' }: { message: string; className?: string }) => (
  <div
    role="alert"
    className={`w-full rounded-xl px-3 py-2.5 flex flex-col gap-2 ${className}`}
    style={{ background: '#2a1212', border: '1px solid #5c2323' }}
  >
    <span
      className="text-sm leading-snug select-text cursor-text"
      style={{ color: '#ffb4b4', wordBreak: 'break-word', userSelect: 'text', WebkitUserSelect: 'text' }}
    >
      {message}
    </span>
    <ErrorActions message={message} color="#ffb4b4" />
  </div>
);
