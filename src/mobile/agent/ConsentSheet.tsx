import { createPortal } from 'react-dom';
import { ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { NOT_SENT_TEXT, PAID_EXTRA_TEXT, SENT_TEXT, consentInfo, type ConsentTarget } from './consent';

const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

/** "Allow b agent to send your messages to <provider>?" Shown before the first message per provider. */
export const ConsentSheet = ({
  target,
  onAllow,
  onCancel,
}: {
  target: ConsentTarget;
  onAllow: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  const info = consentInfo(target);
  const row = (label: string, text: string) => (
    <div className="rounded-xl px-3 py-2.5" style={{ background: '#0d0e11', border: `1px solid ${LINE}` }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: MUTED }}>
        {label}
      </div>
      <div className="mt-0.5 text-[13px] leading-snug text-white">{text}</div>
    </div>
  );
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={onCancel}>
      <div
        role="dialog"
        aria-label={`Share messages with ${info.provider}`}
        className="w-full max-h-[90vh] overflow-y-auto rounded-t-2xl px-5 pt-5 flex flex-col gap-2.5"
        style={{ background: PANEL, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} color={GOLD} />
          <span className="text-base font-bold text-white">Send your messages to {info.provider}?</span>
        </div>
        <p className="text-xs" style={{ color: MUTED }}>
          b is an AI assistant run by a third party, {info.provider}. To answer you, what you type has to leave this
          phone.
        </p>
        {row('Sent', SENT_TEXT)}
        {row('Goes to', info.route)}
        {target === 'paid' && row('Payment', PAID_EXTRA_TEXT)}
        {row('Not sent', NOT_SENT_TEXT)}
        <p className="text-[11px]" style={{ color: MUTED }}>
          {info.provider} processes it under {info.terms}. Don’t type your recovery phrase or private keys. You can
          withdraw this in Settings › b agent.
        </p>
        <button
          onClick={onAllow}
          className="mt-1 rounded-full py-3 text-sm font-bold"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Allow and send
        </button>
        <button onClick={onCancel} className="py-2 text-xs" style={{ color: MUTED }}>
          Don’t allow
        </button>
      </div>
    </div>,
    document.body,
  );
};
