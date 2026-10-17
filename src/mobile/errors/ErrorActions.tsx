import { useContext, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { ServiceContext } from '../../contexts/ServiceContext';
import { reportToB } from '../agent/paid';
import { ChatApiError, saveSession } from '../chat/api';
import { kycClient, signedInClient } from '../kyc/kycWallet';
import { askB, copyError, errorReportText, redactSecrets } from './errorReport';

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
  // "Report to b" files the error with the team (bit-sign feedback log) instead of asking b's AI to guess a cause:
  // b once told the owner a broadcast refusal was a one-click-pay limit (17 Oct 2026). The ref comes back here.
  // Plain useContext: error UI also renders outside the provider (boot errors), where it falls back to Ask b.
  const apiContext = useContext(ServiceContext)?.apiContext;
  // null → idle, 'sending' → in flight, { ref } → filed (ref like "F-8", may be empty).
  const [sent, setSent] = useState<null | 'sending' | { ref: string }>(null);
  const report = async () => {
    if (sent) return;
    if (!apiContext) {
      onAsk?.();
      return askB(message);
    }
    setSent('sending');
    const text = redactSecrets(errorReportText(message));
    const call = (m: 'GET' | 'POST', p: string, b?: unknown) =>
      signedInClient(apiContext)
        .then((c) => c.agentCall(m, p, b))
        .catch(async (e) => {
          if (!(e instanceof ChatApiError) || e.status !== 401) throw e;
          saveSession(null);
          return (await signedInClient(apiContext, kycClient())).agentCall(m, p, b);
        });
    try {
      const r = await reportToB(call, text);
      // Owner 17 Oct: never just vanish. Confirm in its own full-width row, then close.
      setSent({ ref: (r.ref ?? '').replace(/^#/, '') });
      setTimeout(() => onAsk?.(), 8000);
    } catch {
      setSent(null);
      onAsk?.();
      askB(message);
    }
  };
  const btn =
    'shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold border-0 cursor-pointer select-none';
  if (sent && sent !== 'sending')
    return (
      <span role="status" className="basis-full flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: color + '1a' }}>
        <Check size={16} style={{ color, flexShrink: 0, marginTop: 1 }} />
        <span className="flex flex-col gap-0.5 text-xs leading-snug" style={{ color }}>
          <span className="font-semibold">Reported to b{sent.ref ? ` · Ref ${sent.ref}` : ''}</span>
          <span>Sorry about this. We're looking into it.</span>
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
