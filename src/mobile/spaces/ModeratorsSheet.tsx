import { useState } from 'react';
import { X } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { ErrorNotice } from '../errors/ErrorActions';

/**
 * Space moderators (owner, 11 Oct 2026: "I'll delegate some moderators as my friends come on
 * board"). The room owner's people (room admins, named hosts) add or remove moderators by
 * @handle. Moderators can mute a speaker, move them to the audience or remove them from the
 * Space, but never the live host or the room owner. bit-sign `set_moderators` decides; the list
 * comes from the Space reply (`moderators`, only sent to people who may appoint).
 */

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export const ModeratorsSheet = ({
  ticker,
  client,
  initial,
  onClose,
  onChange,
}: {
  ticker: string;
  client: BchatClient;
  initial: string[];
  onClose: () => void;
  onChange?: (list: string[]) => void;
}) => {
  const [list, setList] = useState<string[]>(initial);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (change: { add?: string; remove?: string }) => {
    setBusy(true);
    setError('');
    try {
      const d = (await client.spaceAction(ticker, { action: 'set_moderators', ...change })) as { moderators?: unknown };
      const next = Array.isArray(d?.moderators) ? d.moderators.filter((h): h is string => typeof h === 'string') : list;
      setList(next);
      onChange?.(next);
      if (change.add) setHandle('');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const clean = handle.trim().replace(/^[@$]/, '');

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-3 sm:items-center"
      role="dialog"
      aria-label="Moderators"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl p-5"
        style={{ background: '#0B0A08', border: '1px solid #F5C54240' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold text-white">Moderators</h2>
          <button aria-label="Close" onClick={onClose} className="p-1">
            <X size={18} color="#fff" />
          </button>
        </div>
        <p className="mt-1 text-[13px]" style={{ color: MUTED }}>
          Moderators can mute a speaker, move them to the audience, or remove them from the Space.
        </p>
        <ul className="mt-4 space-y-2">
          {list.length === 0 ? (
            <li className="text-[13px]" style={{ color: MUTED }}>
              No moderators yet.
            </li>
          ) : (
            list.map((h) => (
              <li
                key={h}
                className="flex items-center justify-between rounded-2xl px-3 py-2"
                style={{ background: '#ffffff08', border: '1px solid #ffffff12' }}
              >
                <span className="text-sm text-white">@{h}</span>
                <button
                  disabled={busy}
                  onClick={() => void save({ remove: h })}
                  className="text-xs font-semibold disabled:opacity-40"
                  style={{ color: MUTED }}
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (clean) void save({ add: clean });
          }}
        >
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@handle"
            aria-label="Handle to add as a moderator"
            autoCapitalize="none"
            autoCorrect="off"
            className="min-w-0 flex-1 rounded-full bg-black px-4 py-2 text-sm text-white outline-none"
            style={{ border: '1px solid #ffffff1a' }}
          />
          <button
            type="submit"
            disabled={busy || !clean}
            className="rounded-full px-4 py-2 text-sm font-bold disabled:opacity-40"
            style={{ background: GOLD, color: '#010101' }}
          >
            Add
          </button>
        </form>
        {error ? <ErrorNotice message={error} className="mt-3 text-[12px] text-red-400" /> : null}
      </div>
    </div>
  );
};
