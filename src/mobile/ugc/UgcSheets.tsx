import { useState, type ReactNode } from 'react';
import { useTermsAccepted } from './useTermsAccepted';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { isNative } from '../native';
import { defaultHttp } from '../chat/api';
import { openDappBrowser } from '../dappBrowser';
import {
  REPORT_REASONS,
  SUPPORT_EMAIL,
  TERMS_LINE,
  TERMS_URL,
  acceptTerms,
  sendReport,
  termsSheetNeeded,
  type Report,
} from './ugc';

const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

/**
 * The one terms line (owner, 3 Nov 2026), set just above the last Continue of create / restore and in the sheet
 * below. The Continue it sits over calls acceptTerms(). "Terms of Use" opens the full text.
 */
export const TermsLine = ({
  className = '',
  color = MUTED,
  size = 11,
  align = 'center',
}: {
  className?: string;
  color?: string;
  size?: number;
  align?: 'center' | 'left';
}) => (
  <p
    className={`m-0 leading-snug ${className}`}
    style={{ color, fontSize: size, textAlign: align }}
    data-testid="terms-line"
  >
    {TERMS_LINE.before}
    <button
      type="button"
      onClick={() => void openDappBrowser(TERMS_URL)}
      className="inline p-0 m-0 border-0 bg-transparent underline cursor-pointer"
      style={{ color: GOLD, fontSize: 'inherit', lineHeight: 'inherit' }}
    >
      {TERMS_LINE.link}
    </button>
    {TERMS_LINE.after}
  </p>
);

/**
 * A wallet that never agreed (made before 3 Nov 2026, or agreed to an older TERMS_VERSION): the same line once,
 * as a small sheet right after unlock, one tap Continue. It covers everything until then, so Feed, Chat, DMs and
 * Calls are never reachable without it, in every build. Mounted once inside the router (App.tsx).
 */
export const TermsOnceSheet = ({ hasWallet, locked }: { hasWallet: boolean; locked: boolean }) => {
  const { pathname } = useLocation();
  const accepted = useTermsAccepted();
  if (!termsSheetNeeded({ accepted, hasWallet, locked, pathname })) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1200] flex items-end bg-black/60" data-testid="terms-sheet">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Terms of Use"
        className="w-full rounded-t-2xl px-5 pt-5 flex flex-col gap-4"
        style={{ background: PANEL, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
      >
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} color={GOLD} className="shrink-0 mt-0.5" />
          <TermsLine align="left" size={13} color="#fff" />
        </div>
        <button
          type="button"
          onClick={acceptTerms}
          className="rounded-full py-3 text-sm font-bold border-0"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Continue
        </button>
      </div>
    </div>,
    document.body,
  );
};

/** Settings › Terms of use: the line, whether this device agreed, the full text, and the contact. */
export const TermsScreen = ({ onBack }: { onBack: () => void }) => {
  useBackClose(true, onBack);
  const ok = useTermsAccepted();
  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
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
        <div
          className="w-full rounded-2xl p-5 flex flex-col gap-3"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} color={GOLD} />
            <span className="text-base font-bold text-white">Terms of use</span>
          </div>
          <TermsLine align="left" size={13} color="#fff" />
          <button
            onClick={() => void openDappBrowser(TERMS_URL)}
            className="self-start text-xs underline"
            style={{ color: GOLD }}
          >
            Read the full terms
          </button>
          {ok ? (
            <p className="text-xs" style={{ color: '#5ad17a' }}>
              You agreed to these terms on this device.
            </p>
          ) : (
            <button
              onClick={acceptTerms}
              className="mt-1 rounded-full py-3 text-sm font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Continue
            </button>
          )}
        </div>
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
