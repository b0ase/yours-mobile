import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Gamepad2, Volume2, VolumeX } from 'lucide-react';
import type { Room, RemoteTrack } from 'livekit-client';
import type { BchatClient } from './api';
import { IS_EXTENSION } from '../extension';
import { playTerrornode } from '../games/playTerrornode';
import {
  LIVE_POLL_MS,
  PREVIEW_SECONDS,
  ROOM_QUERY_ACTION,
  ROOM_TAB_EVENT,
  dropTab,
  gameRoomVideo,
  goliveCountPath,
  golivePath,
  noteTab,
  parseRoomPlaying,
  playerSource,
  previewLimited,
  readCollapsed,
  tabWatching,
  writeCollapsed,
  type TabState,
} from './gameRoomLive';

/**
 * Compact live player at the top of a game room's chat (TERRORNODE). See chat/gameRoomLive.ts for the rules.
 *
 *   - live stream when someone is live (watch-only LiveKit token from bit-sign, as the web room gets it);
 *   - otherwise the idle loop (muted, playsinline, loop; loaded only while expanded);
 *   - 45 s preview for viewers who are not live (and for signed-out viewers, on the idle loop), then the earn card.
 *
 * Collapsible, remembered per room. Its height is capped (30% of the screen) and it never grows, so the message
 * bar below always stays on screen: phone portrait, landscape (left-rail layout) and the extension side panel.
 * In the side panel, a bChatX tab already playing this room shows "Watching in tab" instead of a second player.
 */
const RED = '#FF4D6D';

type Stream = { identity: string; handle: string; video: RemoteTrack | null; audio: RemoteTrack | null };

const handleOf = (identity: string) => (identity.startsWith('live:') ? identity.slice(5) : null);

export const GameRoomPlayer = ({
  client,
  ticker,
  signedIn,
}: {
  client: BchatClient;
  ticker: string;
  signedIn: boolean;
}) => {
  const video = gameRoomVideo(ticker);
  if (!video) return null;
  return <Player client={client} ticker={video.ticker} signedIn={signedIn} />;
};

const Player = ({ client, ticker, signedIn }: { client: BchatClient; ticker: string; signedIn: boolean }) => {
  const cfg = gameRoomVideo(ticker)!;
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => readCollapsed(ticker));
  const [live, setLive] = useState(0);
  const [playToEarn, setPlayToEarn] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [previewOver, setPreviewOver] = useState(false);
  const [playHere, setPlayHere] = useState(false);
  const [tabs, setTabs] = useState<TabState>({});
  const [now, setNow] = useState(() => Date.now());
  const [streams, setStreams] = useState<Stream[]>([]);
  const [pick, setPick] = useState(0);
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const toggle = () =>
    setCollapsed((c) => {
      writeCollapsed(ticker, !c);
      return !c;
    });

  // Live count: the member route when signed in (it also says play-to-earn and whether I'm live), else the public
  // count (numbers only). Every failure leaves the idle loop.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        if (signedIn) {
          const j = (await client.request('GET', golivePath(ticker))) as {
            live?: unknown;
            play_to_earn?: unknown;
            playing?: unknown;
          };
          if (stop) return;
          setLive(Number(j.live) || 0);
          setPlayToEarn(j.play_to_earn !== false);
          setPlaying(j.playing === true);
        } else {
          const j = (await client.request('GET', goliveCountPath(ticker), undefined, false)) as { live?: unknown };
          if (!stop) setLive(Number(j.live) || 0);
        }
      } catch {
        /* next tick */
      }
    };
    void tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [client, ticker, signedIn]);

  // One player at a time (extension side panel): hear open bChatX room tabs, and ask them to re-announce.
  useEffect(() => {
    if (!IS_EXTENSION) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { tabId?: unknown; closed?: unknown } | null;
      if (!d || (typeof d.tabId !== 'number' && typeof d.tabId !== 'string')) return;
      const tabId = d.tabId;
      if (d.closed === true) return setTabs((s) => dropTab(s, tabId));
      const msg = parseRoomPlaying(d);
      if (msg) setTabs((s) => noteTab(s, tabId, msg, Date.now()));
    };
    window.addEventListener(ROOM_TAB_EVENT, on);
    try {
      chrome.runtime?.sendMessage({ action: ROOM_QUERY_ACTION })?.catch(() => undefined);
    } catch {
      /* extension reloaded */
    }
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      window.removeEventListener(ROOM_TAB_EVENT, on);
      clearInterval(id);
    };
  }, []);

  const inTab = IS_EXTENSION && tabWatching(tabs, ticker, now);
  const source = playerSource({ signedIn, live, tabWatching: inTab, playHere, previewOver });
  // The 45 s preview: live video for a viewer who is not live (play-to-earn rooms), or the idle loop signed out.
  const limited = (source === 'live' && previewLimited({ playToEarn, playing })) || (source === 'idle' && !signedIn);

  useEffect(() => {
    if (collapsed || !limited || previewOver) return;
    const id = setTimeout(() => setPreviewOver(true), PREVIEW_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [collapsed, limited, previewOver]);

  // The live stream: connect only while expanded and live. LiveKit loads on demand (it is not in the chat chunk).
  const roomRef = useRef<Room | null>(null);
  const watching = !collapsed && source === 'live';
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const j = (await client.request('POST', golivePath(ticker))) as {
          token?: string;
          url?: string;
          playing?: unknown;
        };
        if (cancelled || !j.token || !j.url) return;
        setPlaying(j.playing === true);
        const lk = await import('livekit-client');
        if (cancelled) return;
        const room = new lk.Room({ adaptiveStream: true, dynacast: false });
        roomRef.current = room;
        const rebuild = () => {
          const list: Stream[] = [];
          room.remoteParticipants.forEach((p) => {
            const handle = handleOf(p.identity);
            if (!handle) return;
            let v: RemoteTrack | null = null;
            let a: RemoteTrack | null = null;
            p.trackPublications.forEach((pub) => {
              if (!pub.track) return;
              if (pub.kind === lk.Track.Kind.Video) v = pub.track as RemoteTrack;
              else if (pub.kind === lk.Track.Kind.Audio) a = pub.track as RemoteTrack;
            });
            list.push({ identity: p.identity, handle, video: v, audio: a });
          });
          list.sort((x, y) => x.handle.localeCompare(y.handle));
          setStreams(list);
          setLive(list.length);
        };
        room
          .on(lk.RoomEvent.TrackSubscribed, rebuild)
          .on(lk.RoomEvent.TrackUnsubscribed, rebuild)
          .on(lk.RoomEvent.ParticipantConnected, rebuild)
          .on(lk.RoomEvent.ParticipantDisconnected, rebuild);
        await room.connect(j.url, j.token, { autoSubscribe: true });
        if (cancelled) {
          void room.disconnect();
          return;
        }
        rebuild();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not open the live stream.');
      }
    })();
    return () => {
      cancelled = true;
      void roomRef.current?.disconnect();
      roomRef.current = null;
      setStreams([]);
    };
  }, [watching, client, ticker]);

  const shown = streams.length ? streams[pick % streams.length] : null;
  const label = source === 'tab' ? 'Watching in tab' : live > 0 ? `LIVE · ${live} playing` : `$${ticker}`;

  return (
    <div
      className="bw-game-player w-full min-w-0 shrink-0 overflow-hidden"
      data-game-player={ticker}
      style={{ background: '#050102', borderBottom: `1px solid #5C1520` }}
    >
      <div className="flex items-center gap-2 px-2 h-9">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full${live > 0 && source !== 'tab' ? ' animate-pulse' : ''}`}
          style={{ background: live > 0 ? RED : '#5C1520' }}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold tracking-wide text-white">{label}</span>
        {source === 'tab' && (
          <button
            onClick={() => setPlayHere(true)}
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold active:opacity-60"
            style={{ border: `1px solid ${RED}`, color: '#FFD6DC' }}
          >
            Play here
          </button>
        )}
        {source === 'live' && !collapsed && (
          <button
            onClick={() => setMuted((m) => !m)}
            className="shrink-0 p-1.5 rounded-full active:opacity-60"
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX size={16} color="#FFD6DC" /> : <Volume2 size={16} color="#FFD6DC" />}
          </button>
        )}
        <button
          onClick={() => playTerrornode(navigate)}
          className="shrink-0 flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-extrabold active:opacity-70"
          style={{ background: '#B3121E', color: '#fff' }}
          aria-label={`Play ${ticker} full screen`}
        >
          <Gamepad2 size={13} /> PLAY
        </button>
        {source !== 'tab' && (
          <button
            onClick={toggle}
            className="shrink-0 p-1.5 rounded-full active:opacity-60"
            aria-label={collapsed ? 'Show the live player' : 'Hide the live player'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronDown size={18} color="#FFD6DC" /> : <ChevronUp size={18} color="#FFD6DC" />}
          </button>
        )}
      </div>
      {!collapsed && source !== 'tab' && (
        // 16:9 of the screen width, but never taller than 30% of the screen: the message bar below must always fit.
        // A fixed height (not aspect-ratio), so the video's own size can never widen the room.
        <div
          className="relative w-full min-w-0 overflow-hidden bg-black"
          style={{ height: 'min(30dvh, calc(100vw * 9 / 16))' }}
        >
          {source === 'ad' ? (
            <EarnCard signedIn={signedIn} earnUrl={cfg.earnUrl} onPlay={() => playTerrornode(navigate)} />
          ) : source === 'live' ? (
            <>
              {shown ? (
                <LiveTile s={shown} muted={muted} onNext={() => setPick((n) => n + 1)} many={streams.length > 1} />
              ) : (
                <span className="absolute inset-0 grid place-items-center text-[11px] text-zinc-400">
                  {error || 'Connecting…'}
                </span>
              )}
            </>
          ) : (
            <video
              src={cfg.idleUrl}
              poster={cfg.poster}
              autoPlay
              loop
              muted
              playsInline
              preload="none"
              className="block h-full w-full object-contain"
            />
          )}
        </div>
      )}
    </div>
  );
};

const useAttach = (track: RemoteTrack | null, ref: React.RefObject<HTMLMediaElement | null>) => {
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, ref]);
};

const LiveTile = ({ s, muted, onNext, many }: { s: Stream; muted: boolean; onNext: () => void; many: boolean }) => {
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  useAttach(s.video, v);
  useAttach(s.audio, a);
  return (
    <button
      type="button"
      onClick={onNext}
      className="absolute inset-0 block"
      aria-label={many ? `Watching ${s.handle}. Tap for the next player` : `Watching ${s.handle}`}
    >
      <video ref={v} autoPlay playsInline muted className="h-full w-full object-contain" />
      <audio ref={a} autoPlay muted={muted} />
      <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-100">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: RED }} />${s.handle}
      </span>
    </button>
  );
};

const EarnCard = ({ signedIn, earnUrl, onPlay }: { signedIn: boolean; earnUrl: string; onPlay: () => void }) => (
  <div className="absolute inset-0 grid place-items-center px-4 text-center" data-earn-url={earnUrl}>
    <div>
      <p className="text-[13px] font-bold text-white">
        {signedIn ? 'Earn $TERRORNODE. The only way to get it is to play.' : 'Sign in to bChatX to watch players live.'}
      </p>
      <button
        onClick={onPlay}
        className="mt-2 rounded-xl px-4 py-2 text-[13px] font-bold text-black active:opacity-80"
        style={{ background: '#FFD24D' }}
      >
        PLAY TO EARN
      </button>
    </div>
  </div>
);

export default GameRoomPlayer;
