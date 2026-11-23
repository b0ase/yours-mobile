import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { bavatarSvg } from '../bavatar/bavatar';
import type { PendingSeal } from '../chat/nativeSeal';
import type { FinishResult } from './session';
import type { SyncState } from './sync';
import { rowTitle, shortHash, wocTxUrl, type SignedRow, type SignedTab } from './signedList';

/** Signed's plain pieces (no data access), so signed.test.ts renders them on their own. */

export const EMPTY_TEXT = 'Nothing signed yet. Documents you sign in bChatX rooms show up here.';
export const TAB_EMPTY: Record<SignedTab, string> = {
  waiting: 'Nothing is waiting for your signature.',
  signed: 'Nothing signed and still waiting to be sealed.',
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

export type FinishState = 'idle' | 'working' | FinishResult;
const FINISH_TEXT: Partial<Record<FinishState, string>> = {
  working: 'Checking…',
  finished: 'Recorded. It is in Sealed now.',
  still_held: 'Not recorded yet. It stays here and is tried again; nothing is paid twice.',
  failed: 'Could not finish just now. Try again in a minute.',
};

export const HeldBanner = ({
  held,
  titleOf,
  onFinish,
  states,
}: {
  held: PendingSeal[];
  titleOf: (documentId: string) => string;
  onFinish: (documentId: string) => void;
  states: Record<string, FinishState>;
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
          const st = states[p.documentId] ?? 'idle';
          return (
            <li key={p.documentId} className="sg-held-item">
              <span className="sg-row-text">
                <span className="sg-row-title">{titleOf(p.documentId)}</span>
                <span className="sg-row-sub">
                  Held since {fmtTime(p.savedAt)}
                  {FINISH_TEXT[st] ? ` · ${FINISH_TEXT[st]}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="sg-btn sg-btn-gold"
                disabled={st === 'working'}
                onClick={() => onFinish(p.documentId)}
              >
                {st === 'working' ? 'Finishing…' : 'Finish'}
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
        </span>
      </span>
    </button>
    <span className="sg-row-chips">
      <HashChip hash={row.docHash} />
      <SealLink txid={row.sealTxid} />
    </span>
  </li>
);
