import { setBlocked } from './blocks';
import { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { ReportSheet } from './UgcSheets';
import { isBlocked, normHandle, onUgcChange, type ReportKind } from './ugc';

const MUTED = '#98A2B3';
const LINE = '#2b2f36';

const useBlocked = (handle: string | null | undefined) => {
  const [blocked, setBlocked] = useState(() => isBlocked(handle));
  useEffect(() => {
    setBlocked(isBlocked(handle));
    return onUgcChange(() => setBlocked(isBlocked(handle)));
  }, [handle]);
  return blocked;
};

/**
 * Report / Block for a person (a DM header, a contact). Renders a flag button; the sheet offers
 * the report reasons plus Block (or Unblock). `onBlocked` lets the caller leave the conversation.
 */
export const UserSafetyButton = ({
  client,
  handle,
  kind = 'user',
  target,
  content,
  onBlocked,
  size = 18,
  label,
}: {
  client: BchatClient | null;
  /** The other person's bChat handle. */
  handle: string;
  kind?: ReportKind;
  /** What is reported; defaults to $handle. */
  target?: string;
  content?: string;
  onBlocked?: () => void;
  size?: number;
  /** A full-width labelled button (a sheet's row) in place of the flag icon. */
  label?: string;
}) => {
  const [open, setOpen] = useState(false);
  const blocked = useBlocked(handle);
  const h = normHandle(handle);
  if (!h) return null;
  return (
    <>
      {label ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-2 w-full rounded-full py-3 font-semibold text-white inline-flex items-center justify-center gap-2"
          style={{ background: '#1d1e23' }}
        >
          <Flag size={16} color={MUTED} /> {label}
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="p-2 rounded-full active:opacity-60"
          aria-label={`Report or block $${h}`}
        >
          <Flag size={size} color={MUTED} />
        </button>
      )}
      {open && (
        <ReportSheet
          title={`Report or block $${h}`}
          report={{ kind, target: target ?? `$${h}`, content, details: `user: $${h}` }}
          onClose={() => setOpen(false)}
          extra={
            <button
              onClick={() => {
                void setBlocked(client, h, !blocked);
                setOpen(false);
                if (!blocked) onBlocked?.();
              }}
              className="rounded-xl py-2.5 text-sm font-semibold"
              style={{ background: LINE, color: blocked ? '#FFD24D' : '#ff6b6b' }}
            >
              {blocked ? `Unblock $${h}` : `Block $${h}`}
            </button>
          }
        />
      )}
    </>
  );
};
