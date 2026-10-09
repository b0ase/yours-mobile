/**
 * The green room: the sheet before entering a Space, modelled on X Spaces' pre-join sheet.
 * "LIVE · N listening", the title, the stage (avatar, name, role), "Listen anonymously" and one
 * primary button. bit-sign's rooms/[ticker]/space/green-room supplies the data.
 *
 * Anonymous = a hidden, listen-only LiveKit token and no participant row (bit-sign
 * /space/anon-token). It is still member-gated, so a ticketed room's ticket still applies.
 */
import { ANON_EXPLAINER, RECORDING_NOTICE, audienceLine, greenRoomPrimary, type GreenRoom } from './model';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const hueOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};

export const GreenRoomSheet = ({
  data,
  fallbackTitle,
  anonymous,
  onAnonymous,
  onStart,
  onStartSpeaker,
  speakerFirst = false,
  speakerLine,
  busy,
}: {
  /** "Join as speaker" (absent while anonymous: anonymous listeners cannot speak). */
  onStartSpeaker?: () => void;
  /** Hosts and room admins: the speaker button is the primary one. */
  speakerFirst?: boolean;
  speakerLine?: string;
  data: GreenRoom;
  fallbackTitle: string;
  anonymous: boolean;
  onAnonymous: (v: boolean) => void;
  onStart: () => void;
  busy?: boolean;
}) => (
  <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-6" data-testid="green-room">
    <p className="flex items-center gap-2 text-xs font-semibold">
      <span className="rounded px-1.5 py-[1px] text-[10px] font-bold" style={{ background: '#D92D20', color: '#fff' }}>
        LIVE
      </span>
      <span style={{ color: MUTED }}>{audienceLine(data.listening)}</span>
      {!!data.anonymous && <span style={{ color: MUTED }}>· {data.anonymous} anonymous</span>}
    </p>
    <h2 className="mt-2 text-xl font-bold text-white leading-snug">{data.title || fallbackTitle}</h2>

    {data.recording && (
      <p
        role="status"
        className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
        style={{ background: 'rgba(217,45,32,0.15)', border: '1px solid rgba(217,45,32,0.5)', color: '#fecaca' }}
      >
        <span style={{ color: '#ef4444' }}>●</span> {RECORDING_NOTICE}
      </p>
    )}

    {data.stage.length > 0 && (
      <ul className="mt-5 grid grid-cols-3 gap-4">
        {data.stage.map((p) => (
          <li key={p.handle} className="flex flex-col items-center min-w-0 text-center">
            {p.avatar ? (
              <img src={p.avatar} alt="" className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <span
                className="flex h-16 w-16 items-center justify-center rounded-full text-xl font-bold uppercase text-white"
                style={{ background: `hsl(${hueOf(p.handle)} 45% 30%)` }}
              >
                {p.handle.slice(0, 1)}
              </span>
            )}
            <span className="mt-1 w-full text-sm font-semibold text-white overflow-hidden text-ellipsis whitespace-nowrap">
              ${p.handle}
            </span>
            <span className="text-xs capitalize" style={{ color: MUTED }}>
              {p.role}
            </span>
          </li>
        ))}
      </ul>
    )}

    <div className="mt-6 flex items-start justify-between gap-4 pt-4" style={{ borderTop: `1px solid ${LINE}` }}>
      <div>
        <p className="text-sm font-semibold text-white">Listen anonymously</p>
        <p className="mt-0.5 text-xs" style={{ color: MUTED }}>
          {ANON_EXPLAINER}
        </p>
      </div>
      <button
        role="switch"
        aria-checked={anonymous}
        aria-label="Listen anonymously"
        disabled={busy}
        onClick={() => onAnonymous(!anonymous)}
        className="relative mt-1 h-7 w-12 shrink-0 rounded-full"
        style={{ background: anonymous ? GOLD : '#3a3d44' }}
      >
        <span
          className="absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all"
          style={{ left: anonymous ? 22 : 2 }}
        />
      </button>
    </div>

    <button
      onClick={onStart}
      disabled={busy}
      className="mt-6 h-12 w-full rounded-full text-sm font-bold disabled:opacity-60"
      style={speakerFirst && onStartSpeaker ? { border: `1px solid ${GOLD}`, color: GOLD } : { background: GOLD, color: '#010101' }}
    >
      {busy ? 'Joining…' : greenRoomPrimary({ anonymous, needsTicket: false })}
    </button>
    {onStartSpeaker && (
      <>
        <button
          onClick={onStartSpeaker}
          disabled={busy}
          className="mt-2 h-12 w-full rounded-full text-sm font-bold disabled:opacity-60"
          style={speakerFirst ? { background: GOLD, color: '#010101' } : { border: `1px solid ${GOLD}`, color: GOLD }}
        >
          Join as speaker
        </button>
        {speakerLine && (
          <p className="mt-2 text-center text-[11px]" style={{ color: MUTED }}>
            {speakerLine}
          </p>
        )}
      </>
    )}
  </div>
);

/** In-Space indicator, shown to everyone while a recording runs. */
export const RecordingBadge = () => (
  <span
    role="status"
    className="shrink-0 rounded-full px-2 py-[1px] text-[10px] font-bold"
    style={{ border: '1px solid rgba(217,45,32,0.6)', color: '#fca5a5', background: 'rgba(217,45,32,0.15)' }}
  >
    ● Recording
  </span>
);
