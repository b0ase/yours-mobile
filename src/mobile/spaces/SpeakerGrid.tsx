/**
 * The Space stage as a speaker video grid (owner-approved spec, 9 Oct 2026). Layout rules live in
 * speakerLayout.ts (unit-tested): 1 full screen, 2 stacked, 2×2, 3×3, 4×4, then 4×4 pages with the
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
import type { SpaceMedia } from './media';
import { audienceLine, hostLabel, type Participant } from './model';
import { gridShape, pagesOf, recentlyActive, spareCells, wantsLiveVideo } from './speakerLayout';

/** Desktop/web only: a PiP button on video tiles. Phones float the video on their own (background.ts). */
const webPip = (() => {
  try {
    return !Capacitor.isNativePlatform() && pipSupported();
  } catch {
    return false;
  }
})();

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';

const hueOf = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

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
}) => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!video) return;
    media.bindVideo(p.handle, ref.current);
    return () => media.bindVideo(p.handle, null);
  }, [video, media, p.handle]);
  const hue = hueOf(p.handle);
  const face = size === 'big' ? 96 : size === 'mid' ? 64 : 40;
  const bg = banner
    ? `center / cover no-repeat url("${banner}")`
    : `radial-gradient(120% 100% at 50% 0%, hsl(${hue} 35% 18%) 0%, #0b0b0d 70%)`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onTap()}
      className="relative h-full w-full overflow-hidden rounded-2xl flex items-center justify-center cursor-pointer"
      style={{
        background: bg,
        boxShadow: speaking ? `0 0 0 3px ${GOLD}, 0 0 24px rgba(255,210,77,.45)` : `0 0 0 1px ${LINE}`,
        transition: 'box-shadow .15s',
      }}
      aria-label={`$${p.handle}`}
    >
      {banner && !video && <div className="absolute inset-0 bg-black/45" />}
      {video && p.handle !== me && size !== 'small' && webPip && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void togglePip(ref.current);
          }}
          className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/60 p-1"
          aria-label="Picture in picture"
          title="Picture in picture"
        >
          <PictureInPicture2 size={16} color="#fff" />
        </button>
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
      ) : avatar ? (
        <img
          src={avatar}
          alt=""
          className="relative rounded-full object-cover"
          style={{ width: face, height: face, boxShadow: speaking ? `0 0 0 3px #010101, 0 0 0 6px ${GOLD}` : undefined }}
        />
      ) : (
        <div
          className="relative rounded-full flex items-center justify-center font-bold text-white"
          style={{
            width: face,
            height: face,
            fontSize: face * 0.4,
            background: `hsl(${hue} 55% 42%)`,
            boxShadow: speaking ? `0 0 0 3px #010101, 0 0 0 6px ${GOLD}` : undefined,
          }}
        >
          {p.handle[0]?.toUpperCase() ?? '?'}
        </div>
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
        {p.role === 'host' && size !== 'small' && (
          <span className="shrink-0 rounded px-1 text-[10px] font-bold" style={{ background: GOLD, color: '#010101' }}>
            HOST
          </span>
        )}
      </div>
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

const RequestButton = ({ raised, onRaise, small }: { raised: boolean; onRaise: () => void; small?: boolean }) => (
  <button
    onClick={onRaise}
    className={`rounded-full font-semibold ${small ? 'px-2 py-1 text-[10px]' : 'px-4 py-2 text-sm'}`}
    style={raised ? { background: 'transparent', color: GOLD, boxShadow: `0 0 0 1px ${GOLD}` } : { background: GOLD, color: '#010101' }}
  >
    {raised ? '✋ Hand raised' : '✋ Request to speak'}
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
  listeners: number;
  /** I may raise a hand (a signed-in listener). */
  canHand: boolean;
  raised: boolean;
  /** The existing raise-hand action. */
  onRaiseHand: () => void;
  /** Moderator menu for a tile, or null when I may not moderate them. */
  menuFor: (p: Participant) => (() => void) | null;
  /** Profile pictures by handle, when known. */
  avatars?: Record<string, string | null | undefined>;
  /** The Space or host profile banner, behind camera-off speakers. */
  banner?: string | null;
}

export const SpeakerGrid = ({
  speakers,
  me,
  media,
  videos,
  speaking,
  micOn,
  hostName,
  listeners,
  canHand,
  raised,
  onRaiseHand,
  menuFor,
  avatars,
  banner,
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
        Waiting for the host to come back on stage…
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
        <RequestButton raised={raised} onRaise={onRaiseHand} />
      </div>
    ) : null;

  // Expanded: one large tile; tap it again to go back to the grid.
  const big = expanded ? speakers.find((p) => p.handle === expanded) : null;
  if (big)
    return (
      <div>
        <div style={{ height: '65vh' }}>{tile(big, 'big')}</div>
        {under}
      </div>
    );

  if (n === 1)
    return (
      <div>
        <div style={{ height: '65vh' }}>{tile(speakers[0], 'big')}</div>
        {under}
      </div>
    );
  if (n === 2)
    return (
      <div>
        <div className="grid grid-rows-2 gap-3" style={{ height: '65vh' }}>
          {speakers.map((p) => tile(p, 'mid'))}
        </div>
        {under}
      </div>
    );

  const size = shape.small ? 'small' : 'mid';
  const gridOf = (list: Participant[], last: boolean) => (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`, gridAutoRows: '1fr' }}
    >
      {list.map((p) => (
        <div key={p.handle} style={{ aspectRatio: '1 / 1' }}>
          {tile(p, size)}
        </div>
      ))}
      {last &&
        spare > 0 &&
        Array.from({ length: spare }, (_, i) => (
          <div
            key={`spare${i}`}
            className="flex flex-col items-center justify-center gap-1.5 rounded-2xl p-1 text-center"
            style={{ aspectRatio: '1 / 1', boxShadow: `0 0 0 1px ${LINE}`, background: '#0b0b0d' }}
          >
            {i === 0 && (
              <>
                {listenerLine}
                {canHand && <RequestButton raised={raised} onRaise={onRaiseHand} small={shape.small} />}
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
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: i === curPage ? GOLD : LINE }}
          />
        ))}
      </div>
      {under}
      {!canHand && spare === 0 && <div className="mt-2 flex justify-center">{listenerLine}</div>}
    </div>
  );
};
