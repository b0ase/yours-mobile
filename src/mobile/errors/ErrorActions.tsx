import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { askB, copyError } from './errorReport';

/**
 * "Copy" and "Ask b" for any error (owner, 10 Oct 2026). Use this (or ErrorNotice) wherever an error is
 * shown, so every error can be copied and taken straight to b. Both actions redact secrets first.
 */
export const ErrorActions = ({ message, color = '#fff', onAsk }: { message: string; color?: string; onAsk?: () => void }) => {
  const [copied, setCopied] = useState(false);
  const btn =
    'shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold border-0 cursor-pointer select-none';
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
        aria-label="Ask b about this error"
        className={btn}
        style={{ background: '#F5C542', color: '#0B0A08' }}
        onClick={() => {
          onAsk?.();
          askB(message);
        }}
      >
        <img src={bGlyph} alt="" width={12} height={12} />
        Ask b
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
