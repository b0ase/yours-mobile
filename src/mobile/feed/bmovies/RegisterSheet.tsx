import { createPortal } from 'react-dom';
import { Check, Film } from 'lucide-react';
import { useBackClose } from '../../backStack';

const YELLOW = '#facc15';
const MUTED = '#8a8f98';
const LINE = 'rgba(255,255,255,0.12)';

/**
 * REGISTER's one approval sheet (claim.ts): the clip's poster has proved it is theirs with X; Allow
 * deploys its token from this wallet and registers it. Every step listed, one Allow, nothing to untick.
 */
export const RegisterSheet = ({
  title,
  ticker,
  author,
  busy,
  error,
  onAllow,
  onCancel,
}: {
  title: string;
  ticker: string;
  author: string;
  busy: string;
  error: string;
  onAllow: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  const lines = [
    { label: 'Proved on X', value: `@${author}` },
    { label: 'Token', value: `$${ticker}` },
    { label: 'Supply', value: '1,000,000,000 to your wallet' },
    { label: 'Registered to', value: 'you, the original poster' },
    { label: 'Cost', value: 'network fee only (under 1p)' },
  ];
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/70" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Register your bMovie"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-2xl p-5 flex flex-col gap-3"
        style={{
          background: '#0d0e11',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        }}
      >
        <div
          className="flex items-center gap-3 rounded-xl p-4"
          style={{
            background: 'radial-gradient(circle at 20% 20%, #3a2a00 0%, #120d00 70%)',
            border: `1px solid ${YELLOW}`,
          }}
        >
          <Film size={28} color={YELLOW} />
          <div className="min-w-0">
            <div className="overflow-hidden text-ellipsis whitespace-nowrap text-lg font-extrabold text-white">
              {title}
            </div>
            <div className="text-sm font-bold" style={{ color: YELLOW }}>
              Register ${ticker} on chain
            </div>
          </div>
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2" style={{ color: MUTED }}>
                <Check size={14} color="#A1FF8B" /> {l.label}
              </span>
              <span className="text-white font-semibold text-right">{l.value}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          Once registered, anyone can buy and sell ${ticker} from the reel.
        </p>
        {error && (
          <p className="text-sm m-0" style={{ color: '#FF6B6B' }}>
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={onAllow}
          className="min-h-[48px] w-full rounded-full text-base font-bold disabled:opacity-60"
          style={{ background: YELLOW, color: '#1a1300' }}
        >
          {busy || 'Allow'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={onCancel}
          className="text-sm bg-transparent border-0 cursor-pointer disabled:opacity-40"
          style={{ color: MUTED }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};
