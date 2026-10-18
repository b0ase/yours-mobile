/**
 * A Space's transcript: speakers + host only (bit-sign answers 404 to anyone else). Each speaker can
 * delete their own lines; a deleted line keeps its place and speaker, never its words.
 */
import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { mayRedactLine, parseTranscript, type TranscriptLine } from './transcription';

const MUTED = '#8a8f98';

const time = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export const TranscriptSheet = ({
  client,
  ticker,
  spaceId,
  me,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  spaceId: string;
  me: string;
  onClose: () => void;
}) => {
  const [lines, setLines] = useState<TranscriptLine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client
      .spaceTranscript(ticker, spaceId)
      .then((d) => live && setLines(parseTranscript(d)))
      .catch(() => live && setErr('Only this Space’s speakers and host can read its transcript.'));
    return () => {
      live = false;
    };
  }, [client, ticker, spaceId]);

  const redact = async (id: string) => {
    try {
      await client.spaceRedactLine(ticker, id);
      setLines((ls) => (ls ?? []).map((l) => (l.id === id ? { ...l, text: null, redacted: true } : l)));
    } catch {
      setErr('Could not delete that line.');
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-end" style={{ background: 'rgba(0,0,0,.55)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-2xl p-5 max-h-[80vh] overflow-y-auto"
        style={{ background: '#121316', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <p className="flex-1 text-white font-semibold">Transcript</p>
          <button onClick={onClose} aria-label="Close">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <p className="mt-1 text-xs" style={{ color: MUTED }}>
          Only this Space’s speakers and host can read this. You can delete your own lines.
        </p>
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
        {lines === null && !err && (
          <p className="mt-3 text-sm" style={{ color: MUTED }}>
            Loading…
          </p>
        )}
        {lines?.length === 0 && (
          <p className="mt-3 text-sm" style={{ color: MUTED }}>
            Nothing transcribed yet.
          </p>
        )}
        <ul className="mt-3 flex flex-col gap-3">
          {(lines ?? []).map((l) => (
            <li key={l.id} className="flex items-start gap-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="font-semibold text-white">${l.handle}</span>{' '}
                <span className="text-[11px]" style={{ color: MUTED }}>
                  {time(l.tStart)}
                </span>
                <p style={{ color: l.redacted ? MUTED : '#e5e7eb' }}>
                  {l.redacted ? 'Deleted by the speaker' : l.text}
                </p>
              </div>
              {mayRedactLine(l, me) && (
                <button onClick={() => void redact(l.id)} aria-label="Delete my line" className="p-1">
                  <Trash2 size={16} color={MUTED} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
