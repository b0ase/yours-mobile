/**
 * Chat's "+ New Space": pick a room you may host in (its creator/admin, or an open-stage room like
 * the Lounge), name the Space, then go live there — the same flow as the room's "Start a Space" bar.
 * No such room yet: offer to create one first.
 */
import { useState } from 'react';
import { Mic, X } from 'lucide-react';
import type { BchatClient } from '../chat/api';
import { roomTitle, type ChatRoom } from '../chat/messages';
import { gateOfRoom } from '../chat/tokenRooms';
import { alwaysOpenBarText, canHostRoom, isAlwaysOpenTicker, roomSpaceOpen } from './model';
import { NameSpaceSheet } from './LiveBanner';
import { SpaceScreen } from './SpaceScreen';
import { DoorKeeper } from './DoorKeeper';
import { TRANSCRIPTION_MODES, type TranscriptionMode } from './transcription';
import { TRANSCRIPTION_ENABLED } from '../storeBuild';

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';

/** Rooms this wallet may start a Space in, from the chat list it already has. */
// eslint-disable-next-line react-refresh/only-export-components
export const hostableRooms = (rooms: ChatRoom[], me: string): ChatRoom[] =>
  rooms.filter((r) => canHostRoom({ me, createdBy: r.created_by_handle, spaceOpen: roomSpaceOpen(r) }));

export const NewSpaceSheet = ({
  client,
  me,
  rooms,
  onClose,
  onNewRoom,
}: {
  client: BchatClient;
  me: string;
  rooms: ChatRoom[];
  onClose: () => void;
  onNewRoom: () => void;
}) => {
  const [picked, setPicked] = useState<ChatRoom | null>(null);
  const [start, setStart] = useState<string | null>(null);
  /** Off by default; the host's per-Space choice (bit-sign space-transcription-rules). */
  const [transcription, setTranscription] = useState<TranscriptionMode>('off');
  const list = hostableRooms(rooms, me);

  if (picked && start !== null) {
    return (
      <>
        <DoorKeeper client={client} ticker={picked.ticker} me={me} />
        <SpaceScreen
          client={client}
          ticker={picked.ticker}
          roomName={roomTitle(picked, me)}
          me={me}
          startTitle={isAlwaysOpenTicker(picked.ticker) ? undefined : start}
          startTranscription={isAlwaysOpenTicker(picked.ticker) ? undefined : transcription}
          alwaysOpen={isAlwaysOpenTicker(picked.ticker)}
          spaceOpen={roomSpaceOpen(picked)}
          onClose={onClose}
        />
      </>
    );
  }
  if (picked) {
    return (
      <NameSpaceSheet
        roomName={roomTitle(picked, me)}
        gated={!!gateOfRoom(picked)}
        onCancel={() => setPicked(null)}
        onGo={(t) => setStart(t)}
      />
    );
  }
  return (
    <div className="fixed inset-0 z-[999] flex items-end" style={{ background: 'rgba(0,0,0,.55)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-2xl p-5 max-h-[70vh] overflow-y-auto"
        style={{ background: '#121316', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <p className="flex-1 text-white font-semibold">New Space</p>
          <button onClick={onClose} aria-label="Close">
            <X size={18} color={MUTED} />
          </button>
        </div>
        {list.length ? (
          <>
            <p className="mt-1 text-xs" style={{ color: MUTED }}>
              Pick the room to go live in. Its members can listen and raise a hand.
            </p>
            {TRANSCRIPTION_ENABLED && (
              <fieldset className="mt-3">
                <legend className="text-xs font-semibold text-white">Transcription</legend>
                <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Transcription">
                  {TRANSCRIPTION_MODES.map((m) => (
                    <button
                      key={m.mode}
                      role="radio"
                      aria-checked={transcription === m.mode}
                      onClick={() => setTranscription(m.mode)}
                      className="flex-1 rounded-full px-2 py-1.5 text-[11px] font-semibold"
                      style={
                        transcription === m.mode
                          ? { background: GOLD, color: '#010101' }
                          : { border: '1px solid #2a2b30', color: '#fff' }
                      }
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px]" style={{ color: MUTED }}>
                  {TRANSCRIPTION_MODES.find((m) => m.mode === transcription)?.hint} Speakers are asked first, and anyone
                  can say no.
                </p>
              </fieldset>
            )}
            <div className="mt-3 flex flex-col gap-2">
              {list.map((r) => (
                <button
                  key={r.ticker}
                  onClick={() => {
                    setPicked(r);
                    // Always-open (the Lounge): no naming, just join.
                    if (isAlwaysOpenTicker(r.ticker)) setStart('');
                  }}
                  className="flex items-center gap-3 rounded-xl px-3 py-3 text-left"
                  style={{ background: '#1a1b1f' }}
                >
                  <Mic size={16} color={GOLD} />
                  <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-white">
                    {isAlwaysOpenTicker(r.ticker) ? alwaysOpenBarText(r.ticker, roomTitle(r, me)) : roomTitle(r, me)}
                  </span>
                  <span className="text-xs font-bold" style={{ color: GOLD }}>
                    {isAlwaysOpenTicker(r.ticker) ? 'Join' : 'Go live'}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-xs" style={{ color: MUTED }}>
              A Space runs inside a room you host. You don’t host one yet.
            </p>
            <button
              onClick={onNewRoom}
              className="mt-3 w-full rounded-full py-3 font-semibold"
              style={{ background: GOLD, color: '#010101' }}
            >
              Create a room first
            </button>
          </>
        )}
      </div>
    </div>
  );
};
