import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { isNative } from '../native';
import { defaultHttp } from '../chat/api';
import { openDappBrowser } from '../dappBrowser';
import {
  REPORT_REASONS,
  SUPPORT_EMAIL,
  TERMS_POINTS,
  TERMS_URL,
  acceptTerms,
  onUgcChange,
  sendReport,
  termsAccepted,
  type Report,
} from './ugc';

const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

const useTermsAccepted = () => {
  const [ok, setOk] = useState(termsAccepted);
  useEffect(() => onUgcChange(() => setOk(termsAccepted())), []);
  return ok;
};

/** The terms card: the zero-tolerance summary, a link to the full text, and Agree. */
export const TermsCard = ({ onAgree, agreed }: { onAgree?: () => void; agreed?: boolean }) => (
  <div
    className="w-full rounded-2xl p-5 flex flex-col gap-3"
    style={{ background: PANEL, border: `1px solid ${LINE}` }}
  >
    <div className="flex items-center gap-2">
      <ShieldCheck size={20} color={GOLD} />
      <span className="text-base font-bold text-white">Terms of use</span>
    </div>
    <p className="text-xs" style={{ color: MUTED }}>
      Feed, Chat, messages and calls are shared with other people. By using them you agree to the bWallet and bChat
      terms, including:
    </p>
    <ul className="flex flex-col gap-2">
      {TERMS_POINTS.map((p) => (
        <li key={p} className="text-[13px] leading-snug text-white flex gap-2">
          <span style={{ color: GOLD }}>•</span>
          <span>{p}</span>
        </li>
      ))}
    </ul>
    <button
      onClick={() => void openDappBrowser(TERMS_URL)}
      className="self-start text-xs underline"
      style={{ color: GOLD }}
    >
      Read the full terms
    </button>
    {agreed ? (
      <p className="text-xs" style={{ color: '#5ad17a' }}>
        You agreed to these terms on this device.
      </p>
    ) : (
      <button
        onClick={() => {
          acceptTerms();
          onAgree?.();
        }}
        className="mt-1 rounded-full py-3 text-sm font-bold"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        Agree
      </button>
    )}
  </div>
);

/**
 * Shows `children` only once the terms are agreed on this device. Until then the tab shows the
 * terms card in place of its content (Feed, Chat / DMs, Calls).
 */
export const TermsGate = ({ children, compact }: { children: ReactNode; compact?: boolean }) => {
  const ok = useTermsAccepted();
  if (ok) return <>{children}</>;
  if (compact)
    return (
      <div className="px-4 pb-4">
        <TermsCard />
      </div>
    );
  return (
    <div
      className="w-full h-full overflow-y-auto px-4 flex flex-col items-center"
      style={{
        paddingTop: 'calc(var(--wallet-inset-top, 0px) + 4.5rem)',
        paddingBottom: '7rem',
        background: '#010101',
      }}
    >
      <TermsCard />
    </div>
  );
};

/** Settings › Terms of use: the same card, full screen, with Back. */
export const TermsScreen = ({ onBack }: { onBack: () => void }) => {
  useBackClose(true, onBack);
  const ok = useTermsAccepted();
  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center justify-between px-4 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <span className="text-[16px] font-bold text-white">Terms of use</span>
        <button onClick={onBack} className="text-sm font-semibold" style={{ color: GOLD }}>
          Done
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-24">
        <TermsCard agreed={ok} />
        <p className="mt-4 text-xs" style={{ color: MUTED }}>
          Questions or reports: {SUPPORT_EMAIL}
        </p>
      </div>
    </div>,
    document.body,
  );
};

/**
 * Report sheet (DMs, profiles, b agent replies). Sends to bit-sign's moderation queue.
 * `extra` adds actions under the reasons (e.g. "Block $handle").
 */
export const ReportSheet = ({
  report,
  title,
  onClose,
  onSent,
  extra,
}: {
  report: Omit<Report, 'reason'>;
  title: string;
  onClose: () => void;
  onSent?: () => void;
  extra?: ReactNode;
}) => {
  useBackClose(true, onClose);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (reason: string) => {
    setBusy(true);
    setNote(null);
    try {
      await sendReport(defaultHttp(isNative), { ...report, reason });
      setNote({ ok: true, text: 'Reported. We review reports within 24 hours.' });
      onSent?.();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-end bg-black/60" onClick={() => !busy && onClose()}>
      <div
        className="w-full rounded-t-2xl px-5 pt-5 flex flex-col gap-2.5"
        style={{ background: PANEL, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">{title}</div>
        {note ? (
          <>
            <p className="text-sm" style={{ color: note.ok ? '#5ad17a' : '#ff6b6b' }}>
              {note.text}
            </p>
            {extra}
            <button
              onClick={onClose}
              className="rounded-xl py-2.5 text-sm font-semibold text-white"
              style={{ background: LINE }}
            >
              Close
            </button>
          </>
        ) : (
          <>
            <p className="text-xs" style={{ color: MUTED }}>
              Why are you reporting this? A copy goes to the bWallet team.
            </p>
            {REPORT_REASONS.map((r) => (
              <button
                key={r.id}
                disabled={busy}
                onClick={() => void send(r.id)}
                className="rounded-xl py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: LINE }}
              >
                {r.label}
              </button>
            ))}
            {extra}
            <button onClick={onClose} disabled={busy} className="py-2 text-xs" style={{ color: MUTED }}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
