/**
 * bSpaces: the full-screen Space view (docs/BSPACES-PLAN.md). Stage on top (video tiles or avatars
 * with speaking rings), audience count, the hand queue for the host, controls at the bottom, and the
 * room chat as a slide-up panel (a side panel in landscape).
 *
 * The state half is bit-sign's rooms/[ticker]/space (polled; member-gated, so a token room's holding
 * check is the gate) and the media half is LiveKit via /space/token, which bit-sign mints only for a
 * member who has joined, with publish rights read from their participant row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera,
  CameraOff,
  ChevronDown,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Radio,
  RefreshCw,
  Send,
  Share2,
  Users,
  X,
} from 'lucide-react';
import { useBackClose } from '../backStack';
import { isAdminRefusal as adminRefusal } from '../chat/autoClaim';
import { ChatApiError, type BchatClient } from '../chat/api';
import { latestCursor, mergeMessages, type ChatMessage } from '../chat/messages';
import { SpaceMedia, type Facing } from './media';
import { MediaPermissionNote } from '../permissions/MediaPermissionNote';
import { LevelBars } from './LevelBars';
import { isPermissionDenied, type MediaKind } from '../permissions/mediaPermission';
import {
  audienceCount,
  audienceLine,
  elapsed,
  handQueue,
  isOnStage,
  myChange,
  parseSpaceState,
  parseSpaceToken,
  stageOf,
  supportedTransport,
  type Participant,
  type SpaceState,
} from './model';
import { inviteShareText, parsePage } from './invite';
import { InviteLinksPanel } from '../chat/InviteLinksPanel';
import { shareLink } from '../chat/shareLink';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const POLL_MS = 4_000;
const HEARTBEAT_MS = 15_000;
const CHAT_POLL_MS = 4_000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const hueOf = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

/** Landscape: the stage takes the screen and chat sits beside it. */
const useLandscape = () => {
  const q = '(orientation: landscape) and (max-height: 600px)';
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return !!on;
};

const StageTile = ({
  p,
  video,
  speaking,
  media,
  me,
  big,
  onTap,
  micOff = false,
}: {
  micOff?: boolean;
  p: Participant;
  video: boolean;
  speaking: boolean;
  media: SpaceMedia;
  me: string;
  big: boolean;
  onTap: (() => void) | null;
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!video) return;
    media.bindVideo(p.handle, ref.current);
    return () => media.bindVideo(p.handle, null);
  }, [video, media, p.handle]);
  const hue = hueOf(p.handle);
  return (
    <button
      onClick={onTap ?? undefined}
      disabled={!onTap}
      className="relative overflow-hidden rounded-2xl flex items-center justify-center"
      style={{
        aspectRatio: big ? '16 / 10' : '1 / 1',
        background: `radial-gradient(120% 100% at 50% 0%, hsl(${hue} 35% 18%) 0%, #0b0b0d 70%)`,
        boxShadow: speaking ? `0 0 0 3px ${GOLD}, 0 0 24px rgba(255,210,77,.35)` : `0 0 0 1px ${LINE}`,
        transition: 'box-shadow .15s',
      }}
      aria-label={p.handle}
    >
      {video ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={p.handle === me}
          className="absolute inset-0 h-full w-full object-cover"
          style={p.handle === me ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <div
          className="rounded-full flex items-center justify-center font-bold text-white"
          style={{
            width: big ? 96 : 64,
            height: big ? 96 : 64,
            fontSize: big ? 38 : 26,
            background: `hsl(${hue} 55% 42%)`,
            boxShadow: speaking ? `0 0 0 4px #010101, 0 0 0 7px ${GOLD}` : undefined,
          }}
        >
          {p.handle[0]?.toUpperCase() ?? '?'}
        </div>
      )}
      <div
        className="absolute left-2 bottom-2 right-2 flex items-center gap-1 text-[12px] text-white"
        style={{ textShadow: '0 1px 3px #000' }}
      >
        <LevelBars read={() => media.levelOf(p.handle)} speaking={speaking} muted={micOff} />
        <span className="truncate">${p.handle}</span>
        {p.role === 'host' && (
          <span className="shrink-0 rounded px-1 text-[10px] font-bold" style={{ background: GOLD, color: '#010101' }}>
            HOST
          </span>
        )}
      </div>
    </button>
  );
};

/** Room chat beside the stage. Plain text; paid-message rooms send from the room itself. */
const SpaceChat = ({
  client,
  ticker,
  onClose,
  side,
}: {
  client: BchatClient;
  ticker: string;
  onClose: () => void;
  side: boolean;
}) => {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    client
      .latestPage(ticker, 40)
      .then((p) => live && setMessages(mergeMessages([], p.messages)))
      .catch((e) => {
        if (!live) return;
        setMessages([]);
        setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [client, ticker]);
  useEffect(() => {
    const id = setInterval(() => {
      const c = messages && latestCursor(messages);
      if (!c) return;
      client
        .since(ticker, c)
        .then((fresh) => fresh.length && setMessages((cur) => mergeMessages(cur ?? [], fresh)))
        .catch(() => undefined);
    }, CHAT_POLL_MS);
    return () => clearInterval(id);
  }, [client, ticker, messages]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [messages?.length]);
  const send = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    client
      .send(ticker, body)
      .then((m) => m && setMessages((cur) => mergeMessages(cur ?? [], [m])))
      .catch((e) => {
        setDraft(body);
        setError(
          e instanceof ChatApiError && e.status === 402
            ? 'This room charges per message. Send from the room.'
            : errText(e),
        );
      });
  };
  return (
    <div
      className={side ? 'h-full flex flex-col' : 'absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl'}
      style={{
        background: 'rgba(12,12,14,.97)',
        borderLeft: side ? `1px solid ${LINE}` : undefined,
        borderTop: side ? undefined : `1px solid ${LINE}`,
        height: side ? undefined : '55%',
        zIndex: 5,
      }}
    >
      <div className="flex items-center px-3 py-2" style={{ borderBottom: `1px solid ${LINE}` }}>
        <span className="flex-1 text-sm font-semibold text-white">Chat</span>
        <button onClick={onClose} className="p-1" aria-label="Close chat">
          {side ? <X size={18} color={MUTED} /> : <ChevronDown size={20} color={MUTED} />}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages === null && (
          <p className="pt-4 text-center text-xs" style={{ color: MUTED }}>
            Loading chat…
          </p>
        )}
        {messages?.length === 0 && !error && (
          <p className="pt-4 text-center text-xs" style={{ color: MUTED }}>
            No messages yet. Say hello.
          </p>
        )}
        {(messages ?? [])
          .filter((m) => m.kind === 'text' && m.body)
          .map((m) => (
            <div key={m.id} className="text-[13px] leading-snug">
              <span className="font-semibold" style={{ color: `hsl(${hueOf(m.author_handle ?? '')} 70% 70%)` }}>
                ${m.author_handle}
              </span>{' '}
              <span className="text-white">{m.body}</span>
            </div>
          ))}
        <div ref={end} />
      </div>
      {error && (
        <p className="px-3 text-[11px]" style={{ color: '#F97066' }}>
          {error}
        </p>
      )}
      <form
        className="flex items-center gap-2 p-2"
        style={{ paddingBottom: side ? 8 : 'max(8px, env(safe-area-inset-bottom))' }}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something"
          className="flex-1 rounded-full px-3 py-2 text-sm text-white outline-none"
          style={{ background: '#1a1b1f' }}
        />
        <button type="submit" className="p-2 rounded-full" style={{ background: GOLD }} aria-label="Send">
          <Send size={16} color="#010101" />
        </button>
      </form>
    </div>
  );
};

const CtlButton = ({
  label,
  onClick,
  children,
  active = false,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
}) => (
  <button onClick={onClick} className="flex flex-col items-center gap-1 min-w-[52px]" aria-label={label}>
    <span
      className="h-12 w-12 rounded-full flex items-center justify-center"
      style={{ background: danger ? '#D92D20' : active ? GOLD : '#1d1e23' }}
    >
      {children}
    </span>
    <span className="text-[10px]" style={{ color: MUTED }}>
      {label}
    </span>
  </button>
);

export interface SpaceScreenProps {
  client: BchatClient;
  ticker: string;
  /** The room's name, shown when the space has no title. */
  roomName: string;
  me: string;
  /** Host starting a new space: its title. Omit to join the live one. */
  startTitle?: string;
  /** Shown as an inline "Claim admin" when an admin-only start is refused; true = claimed. */
  onClaimAdmin?: () => Promise<boolean>;
  /** Room admin (issuer / creator): may share an invite even when someone else hosts. */
  canInvite?: boolean;
  onClose: () => void;
}

type Phase = 'joining' | 'live' | 'ended' | 'error';

export const SpaceScreen = ({
  client,
  ticker,
  roomName,
  me,
  startTitle,
  canInvite,
  onClaimAdmin,
  onClose,
}: SpaceScreenProps) => {
  const [needsClaim, setNeedsClaim] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const media = useMemo(() => new SpaceMedia(), []);
  const [phase, setPhase] = useState<Phase>('joining');
  const [error, setError] = useState('');
  const [state, setState] = useState<SpaceState>({ space: null, participants: [], me: null });
  const prev = useRef<SpaceState | null>(null);
  const [videos, setVideos] = useState<string[]>([]);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [facing, setFacing] = useState<Facing>('user');
  const [invited, setInvited] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Participant | null>(null);
  const [note, setNote] = useState('');
  // A denied mic/camera stays on screen (with Open Settings) until fixed or dismissed.
  const [denied, setDenied] = useState<MediaKind | null>(null);
  const refused = (kind: MediaKind, e: unknown, other: string) =>
    isPermissionDenied(e) ? setDenied(kind) : setNote(`${other} (${e instanceof Error ? e.message : String(e)})`);
  const [, tick] = useState(0);
  const landscape = useLandscape();
  const left = useRef(false);

  const leave = useCallback(
    async (end = false) => {
      if (left.current) return;
      left.current = true;
      await client.spaceAction(ticker, { action: end ? 'end' : 'leave' }).catch(() => undefined);
      await media.close();
      onClose();
    },
    [client, ticker, media, onClose],
  );
  useBackClose(true, () => void leave(false));

  // Notes are short status lines; they clear themselves.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(''), 5_000);
    return () => clearTimeout(id);
  }, [note]);

  const apply = useCallback(
    (next: SpaceState) => {
      const change = myChange(prev.current, next);
      prev.current = next;
      setState(next);
      if (change === 'invited') setInvited(true);
      if (change === 'demoted') {
        setInvited(false);
        setMicOn(false);
        setCamOn(false);
        setNote('You’re back in the audience.');
      }
      if (change === 'ended') {
        setPhase('ended');
        void media.close();
      }
    },
    [media],
  );

  // Join → token → connect.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const joined = parseSpaceState(
          await client.spaceAction(ticker, { action: 'join', ...(startTitle ? { title: startTitle } : {}) }),
          me,
        );
        if (!joined.space) throw new Error('This space has ended.');
        if (!supportedTransport(joined.space)) {
          throw new Error('This space is running peer-to-peer. Join it from bChat on the web.');
        }
        const tok = parseSpaceToken(await client.spaceToken(ticker));
        if (!tok) throw new Error('Could not get into the space.');
        await media.connect(tok.url, tok.token, {
          onVideos: (v) => live && setVideos(v),
          onSpeakers: (s) => live && setSpeakers(s),
          onCanPublish: (can) => {
            if (!live) return;
            if (!can) {
              setMicOn(false);
              setCamOn(false);
            }
          },
          onDisconnected: () => live && !left.current && setPhase((p) => (p === 'live' ? 'ended' : p)),
        });
        if (!live) return void media.close();
        prev.current = null;
        apply(joined);
        setPhase('live');
        // The host starts speaking straight away (they started the space); the OS asks for the mic.
        if (joined.me?.role === 'host') {
          await media
            .setMic(true)
            .then(() => setMicOn(true))
            .catch((e) => refused('mic', e, 'Couldn’t start the microphone.'));
        }
      } catch (e) {
        if (!live) return;
        const msg =
          // 403 not_host: bit-sign lets only the token issuer or a room admin start a space.
          e instanceof ChatApiError && e.status === 403 && (e.data as { code?: unknown } | null)?.code === 'not_host'
            ? errText(e)
            : e instanceof ChatApiError && e.status === 403
              ? 'You need to hold this room’s token to join its space.'
              : errText(e);
        setError(msg);
        setNeedsClaim(!!startTitle && adminRefusal(e));
        setPhase('error');
        void media.close();
      }
    })();
    return () => {
      live = false;
    };
    // Join once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => void media.close(), [media]);

  // Poll state, heartbeat presence, tick the clock.
  useEffect(() => {
    if (phase !== 'live') return;
    const poll = setInterval(() => {
      client
        .space(ticker)
        .then((d) => apply(parseSpaceState(d, me)))
        .catch(() => undefined);
      tick((n) => n + 1);
    }, POLL_MS);
    const hb = setInterval(
      () => void client.spaceAction(ticker, { action: 'heartbeat' }).catch(() => undefined),
      HEARTBEAT_MS,
    );
    return () => {
      clearInterval(poll);
      clearInterval(hb);
    };
  }, [phase, client, ticker, me, apply]);

  const act = (body: Record<string, unknown>) =>
    client
      .spaceAction(ticker, body)
      .then((d) => {
        const o = d as { participants?: unknown };
        if (o && Array.isArray(o.participants))
          apply(parseSpaceState({ space: rawSpace(state), participants: o.participants }, me));
      })
      .catch((e) => setNote(errText(e)));

  const myRole = state.me?.role ?? 'listener';
  const onStage = isOnStage(myRole);
  const isHost = myRole === 'host';
  const stage = stageOf(state);
  const hands = handQueue(state);
  const audience = audienceCount(state);
  const raised = !!state.me?.handRaisedAt;

  const toggleMic = async () => {
    try {
      await media.setMic(!micOn);
      setMicOn(!micOn);
    } catch (e) {
      refused('mic', e, 'Couldn’t start the microphone.');
    }
  };
  const toggleCam = async () => {
    try {
      await media.setCamera(!camOn, facing);
      setCamOn(!camOn);
    } catch (e) {
      refused('camera', e, 'Couldn’t start the camera.');
    }
  };
  const flip = async () => {
    const f: Facing = facing === 'user' ? 'environment' : 'user';
    setFacing(f);
    await media.flipCamera(f).catch(() => undefined);
  };
  const accept = async (withCamera: boolean) => {
    setInvited(false);
    try {
      await media.setMic(true);
      setMicOn(true);
    } catch (e) {
      refused('mic', e, 'Couldn’t start the microphone. You’re on stage muted.');
    }
    if (withCamera) await toggleCam();
  };
  const decline = () => {
    setInvited(false);
    void act({ action: 'step_down' });
  };

  const title = state.space?.title || roomName;
  const tiles = stage.length ? stage : [];
  const many = tiles.length > 4;

  const stageView = !tiles.length ? (
    <p className="pt-10 text-center text-sm" style={{ color: MUTED }}>
      Waiting for the host to come back on stage…
    </p>
  ) : (
    <div className={`grid gap-3 ${tiles.length <= 1 ? 'grid-cols-1' : many ? 'grid-cols-3' : 'grid-cols-2'}`}>
      {tiles.map((p) => (
        <StageTile
          key={p.handle}
          p={p}
          me={me.replace(/^\$/, '').toLowerCase()}
          media={media}
          video={videos.includes(p.handle)}
          speaking={speakers.includes(p.handle)}
          micOff={p.handle === me.replace(/^\$/, '').toLowerCase() && !micOn}
          big={tiles.length <= 1}
          onTap={isHost && p.role === 'speaker' ? () => setMenuFor(p) : null}
        />
      ))}
    </div>
  );

  const body =
    phase === 'joining' ? (
      <Centered>
        <Radio size={36} color={GOLD} className="animate-pulse" />
        <p className="mt-3 text-sm" style={{ color: MUTED }}>
          {startTitle ? 'Starting your space…' : 'Joining…'}
        </p>
      </Centered>
    ) : phase === 'error' || phase === 'ended' ? (
      <Centered>
        <p className="text-white text-base font-semibold">
          {phase === 'ended' ? 'This space has ended' : 'Couldn’t join'}
        </p>
        {error && (
          <p className="mt-2 text-sm text-center px-8" style={{ color: MUTED }}>
            {error}
          </p>
        )}
        {phase === 'error' && needsClaim && onClaimAdmin && (
          <button
            disabled={claiming}
            onClick={() => {
              setClaiming(true);
              void onClaimAdmin()
                .then((ok) => !ok && setError('This wallet could not prove it issued this token.'))
                .finally(() => setClaiming(false));
            }}
            className="mt-5 rounded-full px-5 py-2 font-semibold disabled:opacity-50"
            style={{ background: GOLD, color: '#010101' }}
          >
            {claiming ? 'Signing…' : 'Claim admin'}
          </button>
        )}
        <button
          onClick={onClose}
          className="mt-5 rounded-full px-5 py-2 font-semibold"
          style={{ background: GOLD, color: '#010101' }}
        >
          Close
        </button>
      </Centered>
    ) : (
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {stageView}
        {isHost && hands.length > 0 && (
          <section className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: MUTED }}>
              Raised hands
            </h3>
            {hands.map((p) => (
              <div
                key={p.handle}
                className="flex items-center gap-3 py-2"
                style={{ borderBottom: `1px solid ${LINE}` }}
              >
                <Hand size={16} color={GOLD} />
                <span className="flex-1 text-sm text-white truncate">${p.handle}</span>
                <button
                  onClick={() => void act({ action: 'role', handle: p.handle, role: 'speaker' })}
                  className="rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ background: GOLD, color: '#010101' }}
                >
                  Bring on stage
                </button>
              </div>
            ))}
          </section>
        )}
        <div className="mt-5 flex items-center gap-2 text-sm" style={{ color: MUTED }}>
          <Users size={16} />
          {audienceLine(audience)}
        </div>
      </div>
    );

  // Share (docs/BSPACES-PLAN.md, "Invite links and tickets"), host or room admin: the permanent
  // Space page /s/<slug>, or an ephemeral invite /i/<code> with expiry and max uses, plus the list.
  const [shareOpen, setShareOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shareSpacePage = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const page = parsePage(await client.spacePageLink(ticker));
      if (!page?.url) throw new Error('No link came back.');
      const r = await shareLink({ title: page.title, text: inviteShareText(page), url: page.url });
      if (r === 'copied') setNote('Space page link copied.');
      if (r === 'failed') setNote(page.url);
    } catch (e) {
      setNote(
        e instanceof ChatApiError && e.status === 403 ? 'Only the host or the room admin can share.' : errText(e),
      );
    } finally {
      setSharing(false);
    }
  };
  const createInvite = useCallback(
    (opts: { expires_in: string; max_uses?: number }) => client.createSpaceInvite(ticker, opts),
    [client, ticker],
  );
  const listInvites = useCallback(() => client.spaceInvites(ticker), [client, ticker]);
  const revokeInvite = useCallback((code: string) => client.revokeSpaceInvite(ticker, code), [client, ticker]);

  const controls = phase === 'live' && (
    <div
      className={landscape ? 'flex flex-col justify-center gap-3 px-2' : 'flex items-start justify-around px-2 pt-3'}
      style={{
        paddingBottom: landscape ? 8 : 'max(12px, env(safe-area-inset-bottom))',
        borderTop: landscape ? undefined : `1px solid ${LINE}`,
      }}
    >
      {onStage ? (
        <>
          <CtlButton label={micOn ? 'Mute' : 'Unmute'} onClick={() => void toggleMic()} active={micOn}>
            {micOn ? <Mic size={20} color="#010101" /> : <MicOff size={20} color="#fff" />}
          </CtlButton>
          <CtlButton label={camOn ? 'Camera off' : 'Camera'} onClick={() => void toggleCam()} active={camOn}>
            {camOn ? <Camera size={20} color="#010101" /> : <CameraOff size={20} color="#fff" />}
          </CtlButton>
          {camOn && (
            <CtlButton label="Flip" onClick={() => void flip()}>
              <RefreshCw size={18} color="#fff" />
            </CtlButton>
          )}
          {myRole === 'speaker' && (
            <CtlButton
              label="Step down"
              onClick={() => {
                void media.setMic(false).catch(() => undefined);
                void media.setCamera(false, facing).catch(() => undefined);
                setMicOn(false);
                setCamOn(false);
                void act({ action: 'step_down' });
              }}
            >
              <Users size={18} color="#fff" />
            </CtlButton>
          )}
        </>
      ) : (
        <CtlButton
          label={raised ? 'Lower hand' : 'Raise hand'}
          onClick={() => {
            if (!raised) setNote('Hand raised. The host can bring you on stage.');
            void act({ action: 'hand', raised: !raised });
          }}
          active={raised}
        >
          <Hand size={20} color={raised ? '#010101' : '#fff'} />
        </CtlButton>
      )}
      <CtlButton label="Chat" onClick={() => setChatOpen((o) => !o)} active={chatOpen}>
        <MessageSquare size={20} color={chatOpen ? '#010101' : '#fff'} />
      </CtlButton>
      <CtlButton label={isHost ? 'End' : 'Leave'} onClick={() => void leave(isHost)} danger>
        <PhoneOff size={20} color="#fff" />
      </CtlButton>
    </div>
  );

  return createPortal(
    <div
      className="fixed inset-0 flex flex-col"
      style={{ zIndex: 1000, background: 'radial-gradient(140% 70% at 50% 0%, #1a160a 0%, #050505 65%)' }}
      role="dialog"
      aria-label="bSpace"
    >
      <header
        className="flex items-center gap-2 px-3 pb-2 shrink-0"
        style={{ paddingTop: landscape ? 8 : 'max(10px, env(safe-area-inset-top))' }}
      >
        <button onClick={() => void leave(false)} className="p-2" aria-label="Minimise and leave">
          <ChevronDown size={22} color={GOLD} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {phase === 'live' && (
              <span
                className="shrink-0 rounded px-1.5 py-[1px] text-[10px] font-bold"
                style={{ background: '#D92D20', color: '#fff' }}
              >
                LIVE
              </span>
            )}
            <span className="text-[15px] font-semibold text-white truncate">{title}</span>
          </div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            ${ticker.replace(/^\$/, '')}{' '}
            {state.space ? `· ${elapsed(state.space.startedAt)} · ${audienceLine(audience)}` : ''}
          </div>
        </div>
        {phase === 'live' && (isHost || canInvite) && (
          <button
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold"
            style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            aria-label="Share"
          >
            <Share2 size={14} />
            Share
          </button>
        )}
      </header>

      <div className={`flex-1 min-h-0 relative ${landscape ? 'flex' : 'flex flex-col'}`}>
        <div className="flex-1 min-h-0 flex flex-col">{body}</div>
        {landscape ? (
          <>
            {controls}
            {chatOpen && (
              <div className="w-[38%] max-w-[360px]">
                <SpaceChat client={client} ticker={ticker} side onClose={() => setChatOpen(false)} />
              </div>
            )}
          </>
        ) : (
          chatOpen && <SpaceChat client={client} ticker={ticker} side={false} onClose={() => setChatOpen(false)} />
        )}
      </div>
      {!landscape && controls}

      {note && (
        <button
          onClick={() => setNote('')}
          className="absolute left-4 right-4 rounded-xl px-4 py-3 text-sm text-left"
          style={{ bottom: 110, background: '#1d1e23', color: '#fff', zIndex: 10 }}
        >
          {note}
        </button>
      )}

      {denied && (
        <MediaPermissionNote
          kind={denied}
          // Back from Settings: try again so the user can speak without rejoining.
          onRetry={() =>
            onStage &&
            void (denied === 'mic' ? media.setMic(true) : media.setCamera(true, facing))
              .then(() => {
                if (denied === 'mic') setMicOn(true);
                else setCamOn(true);
                setDenied(null);
              })
              .catch(() => undefined)
          }
          onDismiss={() => setDenied(null)}
          className="absolute left-4 right-4 rounded-xl px-4 py-3 text-sm text-left"
          style={{ bottom: 110, background: '#1d1e23', color: '#fff', zIndex: 11 }}
        />
      )}

      {shareOpen && (
        <div
          className="absolute inset-0 flex items-end"
          style={{ background: 'rgba(0,0,0,0.6)', zIndex: 20 }}
          onClick={() => setShareOpen(false)}
        >
          <div
            className="w-full rounded-t-2xl p-4 max-h-[85%] overflow-y-auto"
            style={{ background: '#111215', paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-white font-semibold">Share</span>
              <button onClick={() => setShareOpen(false)} className="p-1" aria-label="Close">
                <X size={18} color={MUTED} />
              </button>
            </div>
            <button
              onClick={() => void shareSpacePage()}
              disabled={sharing}
              className="w-full h-11 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              <Share2 size={15} /> Share Space page
            </button>
            <p className="mt-1 mb-4 text-[11px]" style={{ color: MUTED }}>
              The permanent page for this Space: live now, ended later.
            </p>
            <InviteLinksPanel
              create={createInvite}
              list={listInvites}
              revoke={revokeInvite}
              title={title}
              onNote={setNote}
            />
          </div>
        </div>
      )}

      {invited && (
        <Sheet>
          <p className="text-white text-base font-semibold">You’re invited on stage</p>
          <p className="mt-1 text-sm" style={{ color: MUTED }}>
            The host brought you up. Everyone in the space will hear you. Your camera stays off unless you choose it.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2">
            <button
              onClick={() => void accept(false)}
              className="rounded-full py-3 font-semibold"
              style={{ background: GOLD, color: '#010101' }}
            >
              Join with mic
            </button>
            <button
              onClick={() => void accept(true)}
              className="rounded-full py-3 font-semibold text-white"
              style={{ background: '#1d1e23' }}
            >
              Join with mic and camera
            </button>
            <button onClick={decline} className="rounded-full py-3 text-sm" style={{ color: MUTED }}>
              Decline, stay in the audience
            </button>
          </div>
        </Sheet>
      )}

      {menuFor && (
        <Sheet onClose={() => setMenuFor(null)}>
          <p className="text-white text-base font-semibold">${menuFor.handle}</p>
          <button
            onClick={() => {
              void act({ action: 'role', handle: menuFor.handle, role: 'listener' });
              setMenuFor(null);
            }}
            className="mt-4 w-full rounded-full py-3 font-semibold text-white"
            style={{ background: '#1d1e23' }}
          >
            Move to audience
          </button>
        </Sheet>
      )}
    </div>,
    document.body,
  );
};

/** The participants reply carries no space; keep ours so the state stays whole. */
const rawSpace = (s: SpaceState) =>
  s.space
    ? {
        id: s.space.id,
        title: s.space.title,
        host_handle: s.space.host,
        status: 'live',
        transport: s.space.transport,
        max_participants: s.space.max,
        started_at: s.space.startedAt,
        mode: s.space.mode,
      }
    : null;

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex-1 flex flex-col items-center justify-center">{children}</div>
);

const Sheet = ({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) => (
  <div
    className="absolute inset-0 flex items-end"
    style={{ background: 'rgba(0,0,0,.55)', zIndex: 20 }}
    onClick={onClose}
  >
    <div
      className="w-full rounded-t-2xl p-5"
      style={{ background: '#121316', paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  </div>
);
