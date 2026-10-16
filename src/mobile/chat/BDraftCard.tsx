/**
 * b's partnership drafts in a room: the document card (label, highlighted [TO BE AGREED]
 * placeholders, Accept for members with who has accepted) and the "Ask b to draft" sheet.
 */
import { useState } from 'react';
import type { BchatClient } from './api';
import type { ChatMessage } from './messages';
import {
  B_DRAFT_LABEL,
  MAX_INSTRUCTIONS,
  acceptBDraft,
  bDraftErrorText,
  bDraftInfo,
  countPlaceholders,
  requestBDraft,
  splitPlaceholders,
  type BDraftKind,
} from './bDraft';

const GOLD = '#d4af37';
const MUTED = '#8a8576';
const LINE = '#2a2618';

const STATUS_WORDS: Record<string, string> = {
  adopted: 'Accepted by every member',
  superseded: 'Replaced by a newer draft',
  declined: 'Declined',
};

export function BDraftCard({
  message,
  client,
  ticker,
  me,
  onChanged,
}: {
  message: ChatMessage;
  client: BchatClient;
  ticker: string;
  me: string;
  onChanged: () => void;
}) {
  const info = bDraftInfo(message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepts, setAccepts] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!info) return null;
  const text = message.body || '';
  const list = accepts ?? info.accepts;
  const st = status ?? info.status;
  const meNorm = me.replace(/^\$/, '').toLowerCase();
  const iAccepted = list.some((h) => h.replace(/^\$/, '').toLowerCase() === meNorm);
  const placeholders = countPlaceholders(text);
  const canAccept = info.acceptable && (st === 'open' || st === null) && !iAccepted && !message.pending;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await acceptBDraft(client, ticker, message.id);
      if (r.accepts) setAccepts(r.accepts);
      else setAccepts([...list, me]);
      if (r.status === 'adopted') setStatus('adopted');
      onChanged();
    } catch (e) {
      setError(bDraftErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex justify-start my-2" data-testid="b-draft-card">
      <div
        className="rounded-2xl max-w-[92%] w-full overflow-hidden"
        style={{ background: '#12100a', border: `1px solid ${LINE}` }}
      >
        <div className="px-3 pt-2 pb-1.5" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div className="text-[13px] font-semibold" style={{ color: GOLD }}>
            {info.kind === 'agreement' ? 'Draft agreement' : 'Terms summary'}
          </div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {info.label || B_DRAFT_LABEL}
          </div>
        </div>
        <div
          className="px-3 py-2 text-[13px] whitespace-pre-wrap break-words"
          style={{ color: '#e8e4d6', maxHeight: open ? undefined : 260, overflow: 'hidden' }}
        >
          {splitPlaceholders(text).map((s, i) =>
            s.placeholder ? (
              <mark
                key={i}
                className="px-0.5 rounded font-semibold"
                style={{ background: 'color-mix(in srgb, #f5a524 30%, transparent)', color: '#ffd28a' }}
              >
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </div>
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          <button
            type="button"
            className="self-start text-[12px] underline"
            style={{ color: MUTED }}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Show less' : 'Read the whole draft'}
          </button>
          {placeholders > 0 && (
            <div className="text-[11px]" style={{ color: '#ffd28a' }}>
              {placeholders} point{placeholders === 1 ? '' : 's'} still to be agreed
            </div>
          )}
          {info.acceptable && (
            <div className="text-[11px]" style={{ color: MUTED }}>
              {list.length
                ? `Accepted by ${list.map((h) => `$${h.replace(/^\$/, '')}`).join(', ')}`
                : 'No one has accepted yet'}
              {st && STATUS_WORDS[st] ? ` · ${STATUS_WORDS[st]}` : ''}
            </div>
          )}
          {!info.acceptable && (
            <div className="text-[11px]" style={{ color: MUTED }}>
              For reading only; nothing here is agreed.
            </div>
          )}
          {canAccept && (
            <button
              type="button"
              disabled={busy}
              onClick={accept}
              className="self-start h-9 px-4 rounded-full text-[13px] font-semibold"
              style={{ background: GOLD, color: '#000', opacity: busy ? 0.6 : 1 }}
            >
              {busy ? 'Accepting…' : 'Accept this draft'}
            </button>
          )}
          {info.acceptable && iAccepted && st !== 'adopted' && (
            <div className="text-[11px]" style={{ color: GOLD }}>
              You accepted. Waiting for the other members.
            </div>
          )}
          {error && (
            <div className="text-[12px]" role="alert" style={{ color: '#ff8a8a' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function BDraftSheet({
  client,
  ticker,
  onClose,
  onPosted,
}: {
  client: BchatClient;
  ticker: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [kind, setKind] = useState<BDraftKind>('agreement');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestBDraft(client, ticker, kind, instructions);
      onPosted();
      onClose();
    } catch (e) {
      setError(bDraftErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const choice = (k: BDraftKind, title: string, sub: string) => (
    <button
      type="button"
      onClick={() => setKind(k)}
      aria-pressed={kind === k}
      className="flex-1 text-left rounded-xl px-3 py-2"
      style={{ background: kind === k ? '#1a1608' : '#111', border: `1px solid ${kind === k ? GOLD : LINE}` }}
    >
      <div className="text-[14px] font-semibold" style={{ color: kind === k ? GOLD : '#eee' }}>
        {title}
      </div>
      <div className="text-[11px]" style={{ color: MUTED }}>
        {sub}
      </div>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Ask b to draft"
        className="w-full max-w-md rounded-t-2xl p-4 flex flex-col gap-3"
        style={{
          background: '#0b0b0b',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[16px] font-semibold" style={{ color: '#fff' }}>
          Ask b to draft
        </div>
        <div className="flex gap-2">
          {choice('agreement', 'Draft agreement', 'Every member accepts it')}
          {choice('terms_summary', 'Summarise terms', 'For reading only')}
        </div>
        <textarea
          value={instructions}
          maxLength={MAX_INSTRUCTIONS}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Anything b should include? (optional)"
          rows={3}
          className="w-full rounded-xl px-3 py-2 text-[14px] outline-none"
          style={{ background: '#111', color: '#eee', border: `1px solid ${LINE}` }}
        />
        <div className="text-[11px]" style={{ color: MUTED }}>
          {B_DRAFT_LABEL}. b uses only this room's records and marks anything not agreed as [TO BE AGREED].
        </div>
        {error && (
          <div className="text-[12px]" role="alert" style={{ color: '#ff8a8a' }}>
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-[14px]"
            style={{ color: MUTED }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={go}
            className="h-10 px-5 rounded-full text-[14px] font-semibold"
            style={{ background: GOLD, color: '#000', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? 'b is drafting…' : kind === 'agreement' ? 'Draft agreement' : 'Summarise terms'}
          </button>
        </div>
      </div>
    </div>
  );
}
