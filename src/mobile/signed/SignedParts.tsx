import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { PendingSeal } from '../chat/nativeSeal';
import type { SyncState } from './sync';
import { rowTitle, shortHash, waitingLine, wocTxUrl, type SignedRow } from './signedList';
import {
  BUSY_TEXT,
  FINISHING_ROW_TEXT,
  OLDER_HELD_TEXT,
  PAGE_STATUS,
  artFor,
  finishText,
  fmtDate,
  fmtTime,
  type FinishState,
} from './text';

/** Signed's plain components (no data access), so signed.test.ts renders them on their own. Words: text.ts. */

export const HeldBanner = ({
  held,
  titleOf,
  onFinish,
  onSignIn,
  states,
  busy = new Set<string>(),
  refusedText = () => null,
}: {
  held: PendingSeal[];
  titleOf: (documentId: string) => string;
  onFinish: (documentId: string) => void;
  /** The explicit Sign in tap after Finish asked for it; Finish runs again after it. */
  onSignIn?: (documentId: string) => void;
  states: Record<string, FinishState>;
  /** Documents another page or window is handling now. */
  busy?: ReadonlySet<string>;
  /** "Paid, but bChatX wouldn't record it. Contact support (ref …)" for a document whose held seal bit-sign refused. */
  refusedText?: (documentId: string) => string | null;
}) => {
  if (!held.length) return null;
  const docs = [...new Map(held.map((p) => [p.documentId, p])).values()];
  return (
    <section className="sg-held" aria-label="Held: needs recovery" data-testid="signed-held">
      <h2 className="sg-held-title">Held: needs recovery</h2>
      <p className="sg-held-sub">
        A seal that may have been paid but is not recorded yet. Finish checks it and records it. Nothing is paid again.
      </p>
      <ul className="sg-held-list">
        {docs.map((p) => {
          const st: FinishState = states[p.documentId] ?? { k: 'idle' };
          const isBusy = busy.has(p.documentId) && st.k === 'idle';
          // Paid and refused stays the headline unless this Finish recorded it or said why it was refused (a 5xx or 401
          // on a refused record still shows its support reference).
          const paidRefused =
            st.k === 'recorded' || st.k === 'refused' || st.k === 'working' ? null : refusedText(p.documentId);
          const text = isBusy ? BUSY_TEXT : (paidRefused ?? finishText(st));
          const signIn = st.k === 'sign_in' && !!onSignIn;
          return (
            <li key={p.documentId} className="sg-held-item">
              <span className="sg-row-text">
                <span className="sg-row-title">{titleOf(p.documentId)}</span>
                <span className="sg-row-sub">
                  Held since {fmtTime(p.savedAt)}
                  {text ? ` · ${text}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="sg-btn sg-btn-gold"
                disabled={st.k === 'working' || isBusy}
                onClick={() => (signIn ? onSignIn!(p.documentId) : onFinish(p.documentId))}
              >
                {st.k === 'working' ? 'Finishing…' : signIn ? 'Sign in' : 'Finish'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** A held seal from an older version (no identity key): a neutral line, never counted or finished here. */
export const OlderHeldNote = ({ show }: { show: boolean }) =>
  show ? (
    <p className="sg-note" data-testid="signed-older-held">
      {OLDER_HELD_TEXT}
    </p>
  ) : null;

export const SyncNote = ({
  state,
  cachedAt,
  onSignIn,
  onRetry,
}: {
  state: SyncState;
  cachedAt: number | null;
  onSignIn: () => void;
  onRetry: () => void;
}) => {
  switch (state.k) {
    case 'loading':
      return <p className="sg-note">Checking bChatX for your documents…</p>;
    case 'signed_out':
      return (
        <div className="sg-note sg-note-box" data-testid="signed-signed-out">
          <span>
            Sign in to bChatX to see documents from your rooms. What this wallet has sealed is listed below either way.
          </span>
          <button type="button" className="sg-btn sg-btn-gold" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      );
    case 'offline':
      return (
        <div className="sg-note sg-note-box" data-testid="signed-offline">
          <span>
            You are offline. Showing what this wallet keeps
            {cachedAt ? `, and the list from ${fmtTime(cachedAt)}` : ''}.
          </span>
          <button type="button" className="sg-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    case 'error':
      return (
        <div className="sg-note sg-note-box" role="alert">
          <span>{state.text} What this wallet has sealed is still listed.</span>
          <button type="button" className="sg-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    default:
      return null;
  }
};

export const PageStatus = () => (
  <section className="sg-status" aria-label="What works today">
    <h2 className="sg-status-title">What works today</h2>
    <ul>
      {PAGE_STATUS.map((s) => (
        <li key={s.label} className={s.live ? 'on' : ''}>
          <span aria-hidden>{s.live ? '✓' : '◻'}</span> {s.label}
          {s.live ? '' : ' (coming)'}
        </li>
      ))}
    </ul>
  </section>
);

const openOutside = (url: string) => {
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* no window */
  }
};

/** "#1a2b3c4d", tap to copy the whole hash. */
export const HashChip = ({ hash }: { hash: string }) => {
  const [copied, setCopied] = useState(false);
  const short = shortHash(hash);
  if (!short) return null;
  return (
    <button
      type="button"
      className="sg-chip"
      aria-label={`Document code ${short}. Tap to copy.`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(hash);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? 'Copied' : `#${short}`}
    </button>
  );
};

export const SealLink = ({ txid }: { txid: string | null }) => {
  const url = wocTxUrl(txid);
  if (!url || !txid) return null;
  return (
    <a
      className="sg-chip sg-chip-gold"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="See the seal on WhatsOnChain"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        openOutside(url);
      }}
    >
      Sealed on Bitcoin · {txid.slice(0, 8)} <ExternalLink size={11} aria-hidden />
    </a>
  );
};

export const Row = ({
  row,
  onOpen,
  finishing = false,
}: {
  row: SignedRow;
  onOpen: (r: SignedRow) => void;
  /** A seal of this document is held on this device: it is being finished, not waiting for a signature. */
  finishing?: boolean;
}) => (
  <li className="sg-row" data-testid="signed-row">
    <button type="button" className="sg-row-main" onClick={() => onOpen(row)}>
      <img className="sg-art" src={artFor(row.room || row.title, 72)} alt="" width={36} height={36} />
      <span className="sg-row-text">
        <span className="sg-row-title">{rowTitle(row)}</span>
        <span className="sg-row-sub">
          {row.room ? `$${row.room} · ` : ''}
          {fmtDate(row.at)}
          {finishing ? ` · ${FINISHING_ROW_TEXT}` : row.status === 'waiting' ? ' · Needs your signature' : ''}
          {waitingLine(row) ? ` · ${waitingLine(row)}` : ''}
        </span>
      </span>
    </button>
    <span className="sg-row-chips">
      <HashChip hash={row.docHash} />
      {row.status === 'sealed' && <SealLink txid={row.sealTxid} />}
    </span>
  </li>
);
