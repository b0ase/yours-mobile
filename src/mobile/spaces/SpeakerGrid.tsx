/**
 * The Space stage as a speaker video grid (owner-approved spec, 9 Oct 2026). Layout rules live in
 * speakerLayout.ts (unit-tested): 1 = a 16:9 TV tile, 2 = two 16:9 tiles stacked (side by side when wide), 2×2, 3×3, 4×4, then 4×4 pages with the
 * active speakers on page one. A spare cell holds the listener count and ✋ Request to speak; when
 * the grid is full the button sits under it. Tap a tile to make it large; tap again for the grid.
 *
 * Bandwidth: SpaceMedia runs adaptiveStream + dynacast with simulcast, so each <video> pulls the
 * layer its size needs (small tiles get the low layer). At 4×4 only speakers heard in the last ~10 s
 * stay live; the rest are paused (last frame stays on the tile) via SpaceMedia.setVideoLive.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, PictureInPicture2, Users } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { pipSupported, togglePip } from './background';
import { LevelBars } from './LevelBars';
import { TipButton } from '../tip/TipButton';
import type { SpaceMedia } from './media';
import { audienceLine, hostLabel, type Participant, stageButtonLabel } from './model';
import { bannerUrl, faceArtUrl, fallBackToLocal } from './faceArt';
import { gridShape, pagesOf, recentlyActive, spareCells, tvWidth, wantsLiveVideo } from './speakerLayout';

/** Desktop/web only: a PiP button on video tiles. Phones float the video on their own (background.ts). */
const webPip = (() => {
  try {
    return !Capacitor.isNativePlatform() && pipSupported();
  } catch {
    return false;
  }
})();

const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const Tile = ({
  p,
  video,
  speaking,
  media,
  me,
  size,
  micOff,
  name,
  avatar,
  banner,
  onTap,
  onMenu,
  noHost = false,
  space = '',
}: {
  p: Participant;
  video: boolean;
  speaking: boolean;
  media: SpaceMedia;
  me: string;
  size: 'big' | 'mid' | 'small';
  micOff: boolean;
  name?: string | null;
  avatar?: string | null;
  banner?: string | null;
  onTap: () => void;
  onMenu: (() => void) | null;
  noHost?: boolean;
  /** The Space's room ticker, for the tip record. */
  space?: string;
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!video) return;
    media.bindVideo(p.handle, ref.current);
    return () => media.bindVideo(p.handle, null);
  }, [video, media, p.handle]);
  const face = size === 'big' ? 96 : size === 'mid' ? 64 : 40;
  // Camera off: the speaker's own gold bAvatar fills the tile under a dark shade (gold by default, owner
  // 11 Oct 2026); the room banner is only the fallback behind it.
  const art = faceArtUrl(p.handle);
  const bg = banner ? `center / cover no-repeat url("${banner}")` : '#0b0b0d';
  // Their own uploaded bChatX banner first (an artist's own look, owner 11 Oct 2026); bAvatar art when they have none.
  const [ownBanner, setOwnBanner] = useState(true);
  const face2 = size === 'big' ? 34 : 26;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onTap()}
      className="relative h-full w-full overflow-hidden rounded-2xl flex items-center justify-center cursor-pointer"
      style={{
        background: bg,
        boxShadow: speaking ? `0 0 0 3px ${GOLD}, 0 0 24px rgb(var(--bw-accent-hi-rgb) / .45)` : `0 0 0 1px ${LINE}`,
        transition: 'box-shadow .15s',
      }}
      aria-label={`$${p.handle}`}
    >
      {!video && (
        <>
          {ownBanner ? (
            <img
              src={bannerUrl(p.handle)}
              alt=""
              aria-hidden="true"
              onError={() => setOwnBanner(false)}
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <img
              src={art}
              alt=""
              aria-hidden="true"
              onError={fallBackToLocal(p.handle)}
              className="absolute inset-0 h-full w-full object-cover"
              style={{ transform: 'scale(1.35)' }}
              draggable={false}
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              // Calm like the wallet card (owner, 11 Oct 2026): ~0.6 overall, darkest bottom-left behind the name and mic.
              background:
                'linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.6) 50%, rgba(0,0,0,.85) 100%), linear-gradient(45deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,0) 55%)',
            }}
          />
        </>
      )}
      {video && p.handle !== me && size !== 'small' && webPip && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void togglePip(ref.current);
          }}
          className={`absolute ${onMenu ? 'right-9' : 'right-1.5'} top-1.5 z-10 rounded-full bg-black/60 p-1`}
          aria-label="Picture in picture"
          title="Picture in picture"
        >
          <PictureInPicture2 size={16} color="#fff" />
        </button>
      )}
      {video && size !== 'small' && (
        // Camera on: who it is, top-left (owner, 11 Oct 2026): their uploaded picture, else their gold bAvatar.
        <img
          src={avatar || art}
          alt=""
          aria-hidden="true"
          onError={avatar ? undefined : fallBackToLocal(p.handle)}
          className="absolute left-2 top-2 z-10 rounded-full object-cover"
          style={{
            width: face2,
            height: face2,
            boxShadow: '0 0 0 2px rgb(var(--bw-accent-hi-rgb) / .6), 0 2px 8px rgba(0,0,0,.6)',
          }}
          draggable={false}
        />
      )}
      {video ? (
        <video
          ref={ref}
          data-space-handle={p.handle}
          autoPlay
          playsInline
          muted={p.handle === me}
          className="absolute inset-0 h-full w-full object-cover"
          style={p.handle === me ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <img
          src={avatar || art}
          alt=""
          onError={avatar ? undefined : fallBackToLocal(p.handle)}
          className="relative rounded-full object-cover"
          style={{
            width: face,
            height: face,
            boxShadow: speaking
              ? `0 0 0 3px #010101, 0 0 0 6px ${GOLD}`
              : '0 0 0 2px rgb(var(--bw-accent-hi-rgb) / .35)',
          }}
        />
      )}
      <div
        className={`absolute left-2 bottom-1.5 right-2 flex items-center gap-1 text-white ${size === 'small' ? 'text-[10px]' : 'text-[12px]'}`}
        style={{ textShadow: '0 1px 3px #000' }}
      >
        {size !== 'small' && <LevelBars read={() => media.levelOf(p.handle)} speaking={speaking} muted={micOff} />}
        {name && hostLabel(p.handle, name) !== `$${p.handle}` ? (
          <span className="truncate">
            {name} <span className="opacity-70 text-[10px]">${p.handle}</span>
          </span>
        ) : (
          <span className="truncate">${p.handle}</span>
        )}
        {p.role === 'host' && !noHost && size !== 'small' && (
          <span className="shrink-0 rounded px-1 text-[10px] font-bold" style={{ background: GOLD, color: '#010101' }}>
            HOST
          </span>
        )}
      </div>
      {p.handle !== me && size !== 'small' && (
        <div className="absolute left-1.5 top-1.5 rounded-full bg-black/60">
          <TipButton
            compact
            to={{ name: `$${p.handle}`, paymail: `$${p.handle}` }}
            context={{ kind: 'space', space }}
          />
        </div>
      )}
      {onMenu && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMenu();
          }}
          aria-label={`Manage $${p.handle}`}
          className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white"
        >
          <MoreHorizontal size={size === 'small' ? 12 : 16} />
        </button>
      )}
    </div>
  );
};

const RequestButton = ({
  raised,
  onRaise,
  small,
  openStage = false,
}: {
  raised: boolean;
  onRaise: () => void;
  small?: boolean;
  openStage?: boolean;
}) => (
  <button
    onClick={onRaise}
    className={`rounded-full font-semibold ${small ? 'px-2 py-1 text-[10px]' : 'px-4 py-2 text-sm'}`}
    style={
      raised
        ? { background: 'transparent', color: GOLD, boxShadow: `0 0 0 1px ${GOLD}` }
        : { background: GOLD, color: '#010101' }
    }
  >
    {stageButtonLabel({ openStage, raised })}
  </button>
);

export interface SpeakerGridProps {
  /** On stage, host first (model.ts stageOf). */
  speakers: Participant[];
  /** My handle, normalised (no $, lower case). */
  me: string;
  media: SpaceMedia;
  /** Handles with a live camera (SpaceMedia onVideos). */
  videos: string[];
  /** Handles speaking now (LiveKit active speakers). */
  speaking: string[];
  micOn: boolean;
  hostName?: string | null;
  /** Always-open room: no HOST badge (whoever started is just on stage). */
  noHost?: boolean;
  listeners: number;
  /** I may raise a hand (a signed-in listener). */
  canHand: boolean;
  raised: boolean;
  /** The existing raise-hand action. */
  onRaiseHand: () => void;
  /** Open stage: the button reads "Join the stage" and takes a seat. */
  openStage?: boolean;
  /** Moderator menu for a tile, or null when I may not moderate them. */
  menuFor: (p: Participant) => (() => void) | null;
  /** Profile pictures by handle, when known. */
  avatars?: Record<string, string | null | undefined>;
  /** The Space or host profile banner, behind camera-off speakers. */
  banner?: string | null;
  /** The Space's room ticker (tip records). */
  space?: string;
}

export const SpeakerGrid = ({
  speakers,
  me,
  media,
  videos,
  speaking,
  micOn,
  hostName,
  noHost = false,
  listeners,
  canHand,
  raised,
  onRaiseHand,
  openStage = false,
  menuFor,
  avatars,
  banner,
  space,
}: SpeakerGridProps) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const lastSpoke = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());

  // Remember when each speaker was last heard; tick so the ~10 s window lapses on its own.
  useEffect(() => {
    const t = Date.now();
    for (const h of speaking) lastSpoke.current.set(h, t);
    setNow(t);
  }, [speaking]);
  const n = speakers.length;
  const shape = gridShape(n);
  useEffect(() => {
    if (!shape.dense) return;
    const id = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, [shape.dense]);

  const recent = useMemo(() => recentlyActive(lastSpoke.current, now), [now]);
  const pages = useMemo(() => pagesOf(speakers, recent), [speakers, recent]);
  const curPage = Math.min(page, pages.length - 1);
  if (expanded && !speakers.some((p) => p.handle === expanded)) setExpanded(null);

  // Pause cameras nobody needs live (4×4 quiet speakers, other pages); resume the rest.
  const live = useMemo(() => {
    const on = new Set(pages[curPage] ?? []);
    return new Map(
      speakers.map((p) => [
        p.handle,
        wantsLiveVideo({ handle: p.handle, count: n, recent, expanded, me, onPage: on.has(p) }),
      ]),
    );
  }, [pages, curPage, speakers, n, recent, expanded, me]);
  useEffect(() => {
    for (const h of videos) media.setVideoLive(h, live.get(h) ?? true);
  }, [media, videos, live]);

  if (!n)
    return (
      <p className="pt-10 text-center text-sm" style={{ color: MUTED }}>
        {noHost
          ? openStage
            ? 'Nobody on stage yet. Join the stage to talk.'
            : 'Nobody on stage yet. Request to speak to go up.'
          : 'Waiting for the host to come back on stage…'}
      </p>
    );

  const tile = (p: Participant, size: 'big' | 'mid' | 'small') => (
    <Tile
      key={p.handle}
      p={p}
      me={me}
      media={media}
      video={videos.includes(p.handle)}
      speaking={speaking.includes(p.handle)}
      micOff={p.handle === me && !micOn}
      size={size}
      name={p.role === 'host' ? hostName : null}
      avatar={avatars?.[p.handle] ?? null}
      banner={banner}
      onTap={() => setExpanded((x) => (x === p.handle ? null : p.handle))}
      onMenu={menuFor(p)}
      noHost={noHost}
      space={space}
    />
  );

  const spare = spareCells(n);
  const listenerLine = (
    <span className="flex items-center gap-1 text-xs" style={{ color: MUTED }}>
      <Users size={14} />
      {audienceLine(listeners)}
    </span>
  );
  const under =
    canHand && spare === 0 ? (
      <div className="mt-3 flex items-center justify-center">
        <RequestButton raised={raised} onRaise={onRaiseHand} openStage={openStage} />
      </div>
    ) : null;

  // Expanded: one large tile; tap it again to go back to the grid.
  const big = expanded ? speakers.find((p) => p.handle === expanded) : null;
  if (big)
    return (
      <div>
        <div
          className="mx-auto"
          style={{ width: tvWidth(75), aspectRatio: '16 / 9', minHeight: '45vh', maxWidth: '100%' }}
        >
          {tile(big, 'big')}
        </div>
        {under}
      </div>
    );

  // One speaker: a neat 16:9 TV, full width but never taller than ~55% of the screen.
  if (n === 1)
    return (
      <div>
        <div className="mx-auto" style={{ width: tvWidth(), aspectRatio: '16 / 9' }}>
          {tile(speakers[0], 'big')}
        </div>
        {under}
      </div>
    );
  // Two speakers: two 16:9 tiles, stacked on phones, side by side on wide screens.
  if (n === 2)
    return (
      <div>
        <div className="mx-auto grid grid-cols-1 gap-3 sm:grid-cols-2" style={{ maxWidth: tvWidth(70) }}>
          {speakers.map((p) => (
            <div key={p.handle} style={{ aspectRatio: '16 / 9' }}>
              {tile(p, 'mid')}
            </div>
          ))}
        </div>
        {under}
      </div>
    );

  const size = shape.small ? 'small' : 'mid';
  const gridOf = (list: Participant[], last: boolean) => (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`, alignContent: 'start' }}
    >
      {list.map((p) => (
        <div key={p.handle} style={{ aspectRatio: shape.aspect }}>
          {tile(p, size)}
        </div>
      ))}
      {last &&
        spare > 0 &&
        Array.from({ length: spare }, (_, i) => (
          <div
            key={`spare${i}`}
            className="flex flex-col items-center justify-center gap-1.5 rounded-2xl p-1 text-center"
            style={{ aspectRatio: shape.aspect, boxShadow: `0 0 0 1px ${LINE}`, background: '#0b0b0d' }}
          >
            {i === 0 && (
              <>
                {listenerLine}
                {canHand && (
                  <RequestButton raised={raised} onRaise={onRaiseHand} small={shape.small} openStage={openStage} />
                )}
              </>
            )}
          </div>
        ))}
    </div>
  );

  if (pages.length === 1)
    return (
      <div>
        {gridOf(speakers, true)}
        {under}
      </div>
    );

  return (
    <div>
      <div
        className="flex snap-x snap-mandatory overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (i !== curPage) setPage(i);
        }}
      >
        {pages.map((list, i) => (
          <div key={i} className="w-full shrink-0 snap-start">
            {gridOf(list, i === pages.length - 1)}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-center gap-1.5" aria-label={`Page ${curPage + 1} of ${pages.length}`}>
        {pages.map((_, i) => (
          <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: i === curPage ? GOLD : LINE }} />
        ))}
      </div>
      {under}
      {!canHand && spare === 0 && <div className="mt-2 flex justify-center">{listenerLine}</div>}
    </div>
  );
};
