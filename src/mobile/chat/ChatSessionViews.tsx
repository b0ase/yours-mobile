import { useState } from 'react';
import { HandleFlow } from '../names/HandleFlow';
import { SkeletonRows } from './SkeletonRows';
import type { ChatSessionState } from './sessionRules';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';
const RED = '#F97066';

/**
 * What Chat / DMs show while there is no session yet (owner, 3 Nov 2026: no visible sign-in): a skeleton while it
 * is fetched, one line + Retry when it failed, "Choose your handle" only for a wallet with no name yet, and one line
 * for an account whose bChatX is turned off.
 */
export const ChatSessionPlaceholder = ({
  state,
  label,
  onRetry,
  onClaimed,
  onTurnOn,
}: {
  state: ChatSessionState;
  label: string;
  onRetry: () => void;
  onClaimed: (paymail: string) => Promise<void>;
  onTurnOn: () => void;
}) => {
  const [closed, setClosed] = useState(false);
  if (state.kind === 'needs-handle')
    return closed ? (
      <div className="px-6 pt-10 flex flex-col items-center text-center gap-2">
        <p className="text-xs" style={{ color: MUTED }}>
          Choose a name to start chatting.
        </p>
        <button onClick={() => setClosed(false)} className="text-sm font-bold underline" style={{ color: GOLD }}>
          Choose a name
        </button>
      </div>
    ) : (
      <HandleFlow onClose={() => setClosed(true)} onClaimed={onClaimed} />
    );
  if (state.kind === 'error')
    return (
      <p className="px-6 pt-10 text-center text-xs" style={{ color: RED }} role="alert">
        {state.message}{' '}
        <button onClick={onRetry} className="underline font-semibold" style={{ color: GOLD }}>
          Retry
        </button>
      </p>
    );
  if (state.kind === 'off')
    return (
      <p className="px-6 pt-10 text-center text-xs" style={{ color: MUTED }}>
        Chat is off for this account.{' '}
        <button onClick={onTurnOn} className="underline font-semibold" style={{ color: GOLD }}>
          Turn on
        </button>
      </p>
    );
  return <SkeletonRows label={label} />;
};
