import { useState } from 'react';
import type { SendErrorInfo } from '../utils/sendErrors';
import { errorReportText } from '../mobile/errors/errorReport';

/**
 * A failed send, said plainly: what happened, whether money moved, what to do. The raw reason is behind Details,
 * with Copy, for support. Never a raw Chrome or toolbox string on its own (owner, 28 Oct 2026).
 */
export const SendErrorNotice = ({ info, onClose }: { info: SendErrorInfo; onClose: () => void }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Redacted, with Screen · Version · Edition · Channel appended (mobile/errors/errorReport.ts).
  const report = errorReportText(
    [
      info.message,
      `kind: ${info.kind}`,
      `money moved: ${info.moneyMoved}`,
      info.txid ? `txid: ${info.txid}` : '',
      info.detail,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setOpen(true);
    }
  };
  const btn: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.35)',
    color: 'inherit',
    borderRadius: 8,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  };
  return (
    <div
      role="alert"
      data-testid="send-error"
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 84,
        zIndex: 1000,
        background: '#3a1414',
        color: '#fff',
        border: '1px solid #b33',
        borderRadius: 12,
        padding: 12,
        fontSize: 13,
        lineHeight: 1.4,
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {info.moneyMoved === 'no' ? 'Payment not sent' : 'Payment status unclear'}
      </div>
      <div>{info.message}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={btn} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : 'Details'}
        </button>
        <button type="button" style={btn} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={onClose}>
          Close
        </button>
      </div>
      {open && (
        <pre
          style={{
            marginTop: 8,
            maxHeight: 160,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: 11,
            opacity: 0.85,
          }}
        >
          {report}
        </pre>
      )}
    </div>
  );
};
