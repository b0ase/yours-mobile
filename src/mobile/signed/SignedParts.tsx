import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { bavatarSvg } from '../bavatar/bavatar';
import type { PendingSeal } from '../chat/nativeSeal';
import type { FinishOutcome } from './session';
import type { SyncState } from './sync';
import { rowTitle, shortHash, waitingLine, wocTxUrl, type SignedRow, type SignedTab } from './signedList';

/** Signed's plain pieces (no data access), so signed.test.ts renders them on their own. */

export const EMPTY_TEXT = 'Nothing signed yet. Documents you sign in bChatX rooms show up here.';
export const TAB_EMPTY: Record<SignedTab, string> = {
  waiting: 'Nothing is waiting for your signature.',
  signed: 'Nothing signed and still waiting for others or for its seal.',
  sealed: 'Nothing sealed on Bitcoin yet.',
};

/** The page's own live / coming checklist (owner, 15 Oct 2026: every feature page shows one). */
export const PAGE_STATUS: { label: string; live: boolean }[] = [
  { label: 'Waiting for me', live: true },
  { label: 'Signed', live: true },
  { label: 'Sealed on Bitcoin, with a link to the seal', live: true },
  { label: 'Held seals: Finish', live: true },
  { label: 'Kept on this device, works offline', live: true },
  { label: 'Search', live: false },
  { label: 'Export', live: false },
];

export const fmtDate = (ms: number) =>
  ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unknown';
export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export type FinishState = { k: 'idle' } | { k: 'working' } | FinishOutcome;
/** What the banner says after a Finish: the TRUE outcome, never "Recorded" unless bit-sign recorded it. */
const alsoText = (n?: number) =>
  n ? ` ${n === 1 ? 'One other seal for it was' : `${n} other seals for it were`} recorded.` : '';
export const finishText = (st: FinishState): string => {
  switch (st.k) {
    case 'working':
      return 'Checking…';
    case 'recorded':
      return 'Recorded. It is in Sealed now.';
    case 'orphaned':
      return 'Another party sealed this document first. Your payment is recorded; nothing more to do.';
    case 'replayed':
      return "Already recorded with an earlier payment; this one wasn't needed.";
    case 'released':
      return 'Nothing was paid; you can seal again.';
    case 'kept':
      return 'Still checking. It stays here and is tried again; nothing is paid twice.' + alsoText(st.alsoRecorded);
    case 'wrong_handle':
      return (
        `bChatX doesn't know this seal for the handle you're signed in as (${st.handle ? `$${st.handle.replace(/^[$@]/, '')}` : 'this one'}). ` +
        'It stays held. Sign in as the handle that sealed it.' +
        alsoText(st.alsoRecorded)
      );
    case 'refused':
      return st.reason + alsoText(st.alsoRecorded);
    case 'sign_in':
      return 'Sign in to bChatX to finish this.';
    case 'account_changed':
      return 'You switched accounts. Finish it from the account that sealed it.';
    case 'offline':
      return 'You are offline. Finish it when you are back online.';
    case 'failed':
      return 'Could not finish just now. Try again in a minute.';
    default:
      return '';
  }
};
/** Another page or window is checking or paying this seal right now (held.busyElsewhere): Finish waits. */
export const BUSY_TEXT = 'Being checked in another window. Nothing is paid twice.';

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
          const paidRefused = st.k === 'idle' ? refusedText(p.documentId) : null;
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

const art = new Map<string, string>();
/** Gold by default: a bAvatar seeded by the room (or the title), never a grey tile. */
export const artFor = (seed: string, size: number) => {
  const k = `${size}:${seed}`;
  let a = art.get(k);
  if (!a) {
    a = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(seed || 'signed', { size }));
    art.set(k, a);
  }
  return a;
};

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

export const Row = ({ row, onOpen }: { row: SignedRow; onOpen: (r: SignedRow) => void }) => (
  <li className="sg-row" data-testid="signed-row">
    <button type="button" className="sg-row-main" onClick={() => onOpen(row)}>
      <img className="sg-art" src={artFor(row.room || row.title, 72)} alt="" width={36} height={36} />
      <span className="sg-row-text">
        <span className="sg-row-title">{rowTitle(row)}</span>
        <span className="sg-row-sub">
          {row.room ? `$${row.room} · ` : ''}
          {fmtDate(row.at)}
          {row.status === 'waiting' ? ' · Needs your signature' : ''}
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
