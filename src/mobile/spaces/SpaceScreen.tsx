/**
 * bSpaces: the full-screen Space view (docs/BSPACES-PLAN.md). Stage on top (video tiles or avatars
 * with speaking rings), audience count, the hand queue for the host, controls at the bottom, and the
 * room chat as a slide-up panel (a side panel in landscape).
 *
 * The state half is bit-sign's rooms/[ticker]/space (polled; member-gated, so a token room's holding
 * check is the gate) and the media half is LiveKit via /space/token, which bit-sign mints only for a
 * member who has joined, with publish rights read from their participant row.
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Camera,
  CameraOff,
  ChevronDown,
  Hand,
  Maximize2,
  MessageSquare,
  Monitor,
  Mic,
  MicOff,
  MoreHorizontal,
  Volume2,
  VolumeX,
  PhoneOff,
  Radio,
  RefreshCw,
  Send,
  Share2,
  QrCode,
  Users,
  X,
} from 'lucide-react';
import { useBackClose } from '../backStack';
import { isAdminRefusal as adminRefusal } from '../chat/autoClaim';
import { ChatApiError, type BchatClient } from '../chat/api';
import { latestCursor, mergeMessages, type ChatMessage } from '../chat/messages';
import { SpaceMedia, type Facing } from './media';
import { MediaPermissionNote } from '../permissions/MediaPermissionNote';
import { SpeakerGrid } from './SpeakerGrid';
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
import { GreenRoomSheet, RecordingBadge } from './GreenRoom';
import {
  applyParticipantsReply,
  defaultJoinAs,
  joinAsSpeakerOutcome,
  mayModerate,
  mayRaiseHand,
  moderatable,
  parseGreenRoom,
  wantsWakeLock,
  type GreenRoom,
} from './model';
import { ScreenAwake, wakeLockSupported } from './wakeLock';
import { SpaceBackground, pipFocus } from './background';
import { InviteLinksPanel } from '../chat/InviteLinksPanel';
import { shareText } from '../chat/shareLink';

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

/**
 * A shared screen (live coding): the big tile. `object-contain` so lines of code are not
 * cropped; `muted playsInline autoPlay` so WKWebView / Android WebView start it without a tap
 * (the audio arrives on its own elements). Fullscreen is the zoom: native fullscreen allows
 * pinch-zoom, and iOS only fullscreens the <video> itself (`webkitEnterFullscreen`).
 */
const ScreenTile = ({ owner, media }: { owner: string; media: SpaceMedia }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    media.bindScreen(ref.current);
    return () => media.bindScreen(null);
  }, [media, owner]);
  const full = () => {
    const v = ref.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    const b = box.current;
    if (b?.requestFullscreen) b.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    else v?.webkitEnterFullscreen?.();
  };
  return (
    <div ref={box} className="relative mb-3 overflow-hidden rounded-2xl bg-black" style={{ boxShadow: `0 0 0 1px ${LINE}` }}>
      <video ref={ref} autoPlay playsInline muted onDoubleClick={full} className="block w-full object-contain" style={{ maxHeight: '70vh' }} />
      <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white">
        <Monitor size={12} /> ${owner}&rsquo;s screen
      </span>
      <button onClick={full} aria-label="Fullscreen" className="absolute bottom-2 right-2 rounded-full bg-black/70 p-2 text-white">
        <Maximize2 size={16} />
      </button>
    </div>
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

/** The one tile shown inside the Android PiP window. */
const PipVideo = ({ media, handle }: { media: SpaceMedia; handle: string }) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    media.bindVideo(handle, ref.current);
    media.setVideoLive(handle, true);
    return () => media.bindVideo(handle, null);
  }, [media, handle]);
  return <video ref={ref} data-space-handle={handle} autoPlay playsInline muted className="h-full w-full object-cover" />;
};

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
  /** Open-stage room (model.ts roomSpaceOpen): "Join as speaker" goes straight on stage. */
  spaceOpen?: boolean;
  /** The host's display name if the caller already has it (Space page `host_name`). */
  hostName?: string | null;
  onClose: () => void;
}

/** 'green': the green room, before entering a live Space someone else started. */
type Phase = 'green' | 'joining' | 'live' | 'ended' | 'error';

/**
 * The Space screen behind an error boundary: a render error shows "Something went wrong" with Back
 * and Reload instead of a black screen (owner, 9 Oct 2026: raising a hand blanked the app).
 */
export const SpaceScreen = (props: SpaceScreenProps) => (
  <SpaceBoundary onClose={props.onClose}>
    <SpaceScreenInner {...props} />
  </SpaceBoundary>
);

export class SpaceBoundary extends Component<{ onClose: () => void; children?: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[bwallet] Space screen failed to render', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children ?? null;
    return createPortal(
      <div
        role="alert"
        className="fixed inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center"
        style={{ zIndex: 1000, background: '#050505' }}
      >
        <p className="text-white text-base font-semibold m-0">Something went wrong</p>
        <p className="text-xs m-0 break-words" style={{ color: MUTED }}>
          {this.state.error}
        </p>
        <div className="mt-2 flex gap-3">
          <button
            onClick={() => this.props.onClose()}
            className="rounded-full px-5 py-2 font-semibold text-white"
            style={{ background: '#1d1e23' }}
          >
            Back
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-full px-5 py-2 font-semibold"
            style={{ background: GOLD, color: '#010101' }}
          >
            Reload
          </button>
        </div>
      </div>,
      document.body,
    );
  }
}

const SpaceScreenInner = ({
  client,
  ticker,
  roomName,
  me,
  startTitle,
  canInvite,
  spaceOpen = false,
  hostName: hostNameProp,
  onClaimAdmin,
  onClose,
}: SpaceScreenProps) => {
  const [needsClaim, setNeedsClaim] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const media = useMemo(() => new SpaceMedia(), []);
  const [phase, setPhase] = useState<Phase>(startTitle ? 'joining' : 'green');
  /** The green room's data; null until loaded (or if the server has no green room yet). */
  const [green, setGreen] = useState<GreenRoom | null>(null);
  const [greenAnon, setGreenAnon] = useState(false);
  /**
   * Listening anonymously: hidden listen-only token, NO participant row. So no heartbeat, no
   * hand, and leaving never calls the space route (there is nothing of mine to remove).
   */
  const [anon, setAnon] = useState(false);
  const anonRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState('');
  const [state, setState] = useState<SpaceState>({ space: null, participants: [], me: null });
  const prev = useRef<SpaceState | null>(null);
  const [videos, setVideos] = useState<string[]>([]);
  const [screenOwner, setScreenOwner] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<string[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [facing, setFacing] = useState<Facing>('user');
  const [invited, setInvited] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<Participant | null>(null);
  /** "Mute the room": all incoming audio silenced on this phone (my mic is separate). */
  const [deaf, setDeaf] = useState(false);
  /** Keep the screen on while I host or speak (⋯ menu). */
  const [awakeOn, setAwakeOn] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [hostName, setHostName] = useState<string | null>(hostNameProp ?? null);
  const awake = useMemo(() => new ScreenAwake(), []);
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
      if (!anonRef.current) await client.spaceAction(ticker, { action: end ? 'end' : 'leave' }).catch(() => undefined);
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

  /**
   * Enter: named (join → token → connect) or anonymous (anon token → connect, no row).
   * Starting a space goes straight here; joining someone else's goes through the green room.
   */
  const enter = async (anonymous: boolean, asSpeaker = false) => {
    setPhase('joining');
    if (anonymous) {
      try {
        const tok = parseSpaceToken(await client.spaceAnonToken(ticker));
        if (!tok) throw new Error('Could not get into the space.');
        await media.connect(tok.url, tok.token, {
          onVideos: (v) => mounted.current && setVideos(v),
          onScreen: (o) => mounted.current && setScreenOwner(o),
          onSpeakers: (s) => mounted.current && setSpeakers(s),
          onCanPublish: () => undefined,
          onDisconnected: () => mounted.current && !left.current && setPhase((p) => (p === 'live' ? 'ended' : p)),
        });
        if (!mounted.current) return void media.close();
        anonRef.current = true;
        setAnon(true);
        prev.current = null;
        apply(parseSpaceState(await client.space(ticker), me));
        setPhase('live');
      } catch (e) {
        if (!mounted.current) return;
        setError(errText(e));
        setPhase('error');
        void media.close();
      }
      return;
    }
    try {
      const joined = parseSpaceState(
        await client.spaceAction(ticker, {
          action: 'join',
          ...(startTitle ? { title: startTitle } : {}),
          ...(asSpeaker ? { as: 'speaker' } : {}),
        }),
        me,
      );
      if (!joined.space) throw new Error('This space has ended.');
      if (!supportedTransport(joined.space)) {
        throw new Error('This space is running peer-to-peer. Join it from bChat on the web.');
      }
      const tok = parseSpaceToken(await client.spaceToken(ticker));
      if (!tok) throw new Error('Could not get into the space.');
      await media.connect(tok.url, tok.token, {
        onVideos: (v) => mounted.current && setVideos(v),
        onScreen: (o) => mounted.current && setScreenOwner(o),
        onSpeakers: (s) => mounted.current && setSpeakers(s),
        onCanPublish: (can) => {
          if (!mounted.current) return;
          if (!can) {
            setMicOn(false);
            setCamOn(false);
          }
        },
        onDisconnected: () => mounted.current && !left.current && setPhase((p) => (p === 'live' ? 'ended' : p)),
      });
      if (!mounted.current) return void media.close();
      prev.current = null;
      apply(joined);
      setPhase('live');
      if (asSpeaker && joined.me?.role === 'speaker') setNote('You’re on stage, muted. Tap Unmute to talk.');
      else if (asSpeaker && joined.me?.handRaisedAt) setNote('Hand raised. The host can bring you on stage.');
      // The host starts speaking straight away (they started the space); the OS asks for the mic.
      if (joined.me?.role === 'host') {
        await media
          .setMic(true)
          .then(() => setMicOn(true))
          .catch((e) => refused('mic', e, 'Couldn’t start the microphone.'));
      }
    } catch (e) {
      if (!mounted.current) return;
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
  };

  // Starting: go straight in. Joining: load the green room first.
  useEffect(() => {
    if (startTitle) return void enter(false);
    client
      .spaceGreenRoom(ticker)
      .then((d) => {
        if (!mounted.current) return;
        const g = parseGreenRoom(d);
        if (g) setGreen(g);
        else void enter(false); // No green room (older server / not live): the old path explains.
      })
      .catch(() => mounted.current && void enter(false));
    // Once per mount.
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
    // Anonymous listeners have no row to keep fresh.
    const hb = setInterval(
      () => !anonRef.current && void client.spaceAction(ticker, { action: 'heartbeat' }).catch(() => undefined),
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
        // From the latest state (not this render's), keeping the recording flags (model.ts).
        const next = applyParticipantsReply(prev.current ?? state, d, me);
        if (next) apply(next);
      })
      .catch((e) => setNote(errText(e)));

  const myRole = state.me?.role ?? 'listener';
  const onStage = isOnStage(myRole);
  const isHost = myRole === 'host';
  const stage = stageOf(state);
  const hands = handQueue(state);
  const audience = audienceCount(state);
  const raised = !!state.me?.handRaisedAt;
  const canHand = mayRaiseHand({ anonymous: anon, role: myRole });
  const recording = !!state.recording;
  const moderator = mayModerate({ isHost, roomBoss: canInvite });

  // Mute the room: applies to voices already playing and any that join later (media.ts).
  useEffect(() => media.setDeafened(deaf), [media, deaf]);

  // Screen stays on for anyone in the Space (host, speaker, listener); released on leave or end.
  const wake = wantsWakeLock({ live: phase === 'live', enabled: awakeOn });
  useEffect(() => {
    void awake.set(wake);
  }, [awake, wake]);
  useEffect(() => () => void awake.set(false), [awake]);

  // The host's chosen display name (bit-sign #95 host_name), when the caller did not pass it.
  useEffect(() => {
    if (phase !== 'live' || hostName || !(isHost || canInvite)) return;
    let live = true;
    client
      .spacePageLink(ticker)
      .then((d) => {
        const p = parsePage(d);
        if (live && p?.kind === 'space' && p.hostName) setHostName(p.hostName);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [phase, hostName, isHost, canInvite, client, ticker]);

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
  const myHandle = me.replace(/^\$/, '').toLowerCase();

  // Ducking out to other apps (background.ts): Android foreground service + notification, PiP for
  // live video, lock-screen controls. The buttons there call the latest mute/leave below.
  const [pip, setPip] = useState(false);
  const bgActs = useRef({ mute: () => undefined as unknown, leave: () => undefined as unknown });
  bgActs.current = {
    mute: () => onStage && void toggleMic(),
    leave: () => void leave(false),
  };
  const bg = useMemo(
    () =>
      new SpaceBackground({
        onMute: () => bgActs.current.mute(),
        onLeave: () => bgActs.current.leave(),
        onPip: setPip,
      }),
    [],
  );
  const focus = phase === 'live' ? pipFocus({ stage, videos, speaking: speakers, me: myHandle }) : null;
  useEffect(() => {
    bg.update({ live: phase === 'live', title, onStage, micOn, focus });
  }, [bg, phase, title, onStage, micOn, focus]);
  useEffect(() => () => bg.close(), [bg]);
  const raiseHand = () => {
    if (!raised) setNote('Hand raised. The host can bring you on stage.');
    void act({ action: 'hand', raised: !raised });
  };
  const stageView = (
    <SpeakerGrid
      speakers={stage}
      me={myHandle}
      media={media}
      videos={videos}
      speaking={speakers}
      micOn={micOn}
      hostName={hostName}
      listeners={audience}
      canHand={canHand}
      raised={raised}
      onRaiseHand={raiseHand}
      menuFor={(p) => (moderatable(p, { me, spaceHost: state.space?.host ?? '', moderator }) ? () => setMenuFor(p) : null)}
      avatars={Object.fromEntries((green?.stage ?? []).map((g) => [g.handle, g.avatar]))}
    />
  );

  const body =
    phase === 'green' ? (
      green ? (
        <GreenRoomSheet
          data={green}
          fallbackTitle={roomName}
          anonymous={greenAnon}
          onAnonymous={setGreenAnon}
          onStart={() => void enter(greenAnon)}
          onStartSpeaker={greenAnon ? undefined : () => void enter(false, true)}
          speakerFirst={defaultJoinAs({ spaceOpen, roomBoss: !!canInvite }) === 'speaker'}
          speakerLine={
            joinAsSpeakerOutcome({ spaceOpen, roomBoss: !!canInvite }) === 'speaker'
              ? 'Join as speaker: on stage, mic muted until you tap.'
              : 'Join as speaker: you join with your hand up; the host brings you on stage.'
          }
        />
      ) : (
        <Centered>
          <Radio size={36} color={GOLD} className="animate-pulse" />
        </Centered>
      )
    ) : phase === 'joining' ? (
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
        {screenOwner && <ScreenTile owner={screenOwner} media={media} />}
        {stageView}
        {moderator && hands.length > 0 && (
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
      const r = await shareText(inviteShareText(page));
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
  // QR of the permanent Space page, for a second phone or a screen to scan (Scan in bWalletX or the camera app).
  const [qrUrl, setQrUrl] = useState<{ url: string; img: string } | null>(null);
  const showQr = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const page = parsePage(await client.spacePageLink(ticker));
      if (!page?.url) throw new Error('No link came back.');
      const qr = await import('qrcode');
      setQrUrl({ url: page.url, img: await qr.toDataURL(page.url, { margin: 1, width: 480 }) });
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
      ) : !canHand ? (
        <span className="self-center px-2 text-[11px] text-center" style={{ color: MUTED }}>
          Listening anonymously
        </span>
      ) : (
        <CtlButton
          label={raised ? 'Lower hand' : 'Raise hand'}
          onClick={raiseHand}
          active={raised}
        >
          <Hand size={20} color={raised ? '#010101' : '#fff'} />
        </CtlButton>
      )}
      {state.mayRecord && !anon && (
        <CtlButton
          label={recording ? 'Stop rec' : 'Record'}
          onClick={() => {
            if (!recording) setNote('Recording. Everyone in the Space sees ● Recording.');
            void client
              .spaceAction(ticker, { action: recording ? 'record_stop' : 'record_start' })
              .then(() => client.space(ticker))
              .then((d) => apply(parseSpaceState(d, me)))
              .catch((e) => setNote(errText(e)));
          }}
          active={recording}
          danger={recording}
        >
          <span className="text-base leading-none" style={{ color: recording ? '#fff' : '#ef4444' }}>●</span>
        </CtlButton>
      )}
      <CtlButton label={deaf ? 'Room muted' : 'Mute room'} onClick={() => setDeaf((d) => !d)} active={deaf}>
        {deaf ? <VolumeX size={20} color="#010101" /> : <Volume2 size={20} color="#fff" />}
      </CtlButton>
      <CtlButton label="More" onClick={() => setMoreOpen(true)}>
        <MoreHorizontal size={20} color="#fff" />
      </CtlButton>
      <CtlButton label="Chat" onClick={() => setChatOpen((o) => !o)} active={chatOpen}>
        <MessageSquare size={20} color={chatOpen ? '#010101' : '#fff'} />
      </CtlButton>
      <CtlButton label={isHost ? 'End' : 'Leave'} onClick={() => void leave(isHost)} danger>
        <PhoneOff size={20} color="#fff" />
      </CtlButton>
    </div>
  );

  // Android picture-in-picture: only the focus speaker's video, full-bleed.
  if (pip && focus)
    return createPortal(
      <div className="fixed inset-0 bg-black" style={{ zIndex: 1000 }}>
        <PipVideo media={media} handle={focus} />
      </div>,
      document.body,
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
            {phase === 'live' && recording && <RecordingBadge />}
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
      {phase === 'live' && wake && (
        <p className="text-center text-[10px] pb-1 m-0" style={{ color: MUTED }}>
          Screen stays on while you speak
        </p>
      )}

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
            <button
              onClick={() => void showQr()}
              disabled={sharing}
              className="mt-2 w-full h-11 rounded-xl font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ border: `1px solid ${LINE}`, color: '#fff' }}
            >
              <QrCode size={15} /> Show QR code
            </button>
            {qrUrl && (
              <div className="mt-3 flex flex-col items-center">
                <img src={qrUrl.img} alt="QR code for the Space page" className="w-56 h-56 rounded-lg bg-white" />
                <p className="mt-1 text-[11px] break-all text-center" style={{ color: MUTED }}>
                  {qrUrl.url}
                </p>
              </div>
            )}
            <p className="mt-1 mb-4 text-[11px]" style={{ color: MUTED }}>
              The permanent page for this Space: live now, ended later. Scan the QR in bWalletX or with a phone camera.
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

      {moreOpen && (
        <Sheet onClose={() => setMoreOpen(false)}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-white text-sm font-semibold m-0">Keep screen on in this Space</p>
              <p className="mt-0.5 text-xs m-0" style={{ color: MUTED }}>
                {wakeLockSupported()
                  ? 'Screen stays on while you’re in the Space, so the phone doesn’t sleep mid-Space.'
                  : 'This phone can’t keep the screen on from here; turn auto-lock off in Settings while you’re in a Space.'}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={awakeOn}
              aria-label="Keep screen on in this Space"
              onClick={() => setAwakeOn((v) => !v)}
              className="relative mt-1 h-7 w-12 shrink-0 rounded-full"
              style={{ background: awakeOn ? GOLD : '#3a3d44' }}
            >
              <span className="absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all" style={{ left: awakeOn ? 22 : 2 }} />
            </button>
          </div>
        </Sheet>
      )}

      {menuFor && (
        <Sheet onClose={() => setMenuFor(null)}>
          <p className="text-white text-base font-semibold">${menuFor.handle}</p>
          <button
            onClick={() => {
              void act({ action: 'mute', handle: menuFor.handle }).then(() => setNote(`Muted $${menuFor.handle}. They can unmute themselves.`));
              setMenuFor(null);
            }}
            className="mt-4 w-full rounded-full py-3 font-semibold text-white"
            style={{ background: '#1d1e23' }}
          >
            Mute
          </button>
          <button
            onClick={() => {
              void act({ action: 'role', handle: menuFor.handle, role: 'listener' });
              setMenuFor(null);
            }}
            className="mt-2 w-full rounded-full py-3 font-semibold text-white"
            style={{ background: '#1d1e23' }}
          >
            Move to audience
          </button>
          <button
            onClick={() => {
              void act({ action: 'remove', handle: menuFor.handle });
              setMenuFor(null);
            }}
            className="mt-2 w-full rounded-full py-3 font-semibold"
            style={{ background: '#1d1e23', color: '#F97066' }}
          >
            Remove from Space
          </button>
        </Sheet>
      )}
    </div>,
    document.body,
  );
};


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
