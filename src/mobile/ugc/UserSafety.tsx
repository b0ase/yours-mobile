import { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { ReportSheet } from './UgcSheets';
import { blockLocal, isBlocked, mergeBlocks, normHandle, onUgcChange, unblockLocal, type ReportKind } from './ugc';

const MUTED = '#98A2B3';
const LINE = '#2b2f36';

export const useBlocked = (handle: string | null | undefined) => {
  const [blocked, setBlocked] = useState(() => isBlocked(handle));
  useEffect(() => {
    setBlocked(isBlocked(handle));
    return onUgcChange(() => setBlocked(isBlocked(handle)));
  }, [handle]);
  return blocked;
};

/** Pull the server's block list into the local one (blocks made on another device). Best effort. */
export const syncBlocks = async (client: BchatClient) => {
  try {
    mergeBlocks(await client.blocks());
  } catch {
    /* older server or offline: local blocks still apply */
  }
};

/** Block / unblock $handle: hidden here at once, and the server stops DMs both ways. */
export const setBlocked = async (client: BchatClient | null, handle: string, block: boolean) => {
  if (block) blockLocal(handle);
  else unblockLocal(handle);
  if (!client) return;
  try {
    if (block) await client.block(handle);
    else await client.unblock(handle);
  } catch {
    /* kept locally; the server copy is re-sent next time they block/unblock */
  }
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
}) => {
  const [open, setOpen] = useState(false);
  const blocked = useBlocked(handle);
  const h = normHandle(handle);
  if (!h) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-2 rounded-full active:opacity-60"
        aria-label={`Report or block $${h}`}
      >
        <Flag size={size} color={MUTED} />
      </button>
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
