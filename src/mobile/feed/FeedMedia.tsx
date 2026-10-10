import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ExternalLink, Music, Play } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import type { FeedMedia, LinkEmbed } from './media';
import { isOwnHost, ownLinkPreview, type OgPreview } from './unfurl';
import { usePrefs } from '../settings/usePrefs';

/**
 * Feed media views: swipeable image gallery, tap-to-play video, audio row, link / YouTube /
 * Vimeo cards. Nothing heavy loads until needed: images are lazy small thumbnails, video and
 * audio use preload="none" and only get a src after Play is tapped, and players are torn down
 * when scrolled far off-screen (keeps memory flat on long feeds).
 */
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const PANEL = '#121316';

const stop = (e: MouseEvent) => e.stopPropagation();

/** True while the element is within ~1.5 screens of the viewport. */
function useNearView<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, near];
}

/** True while at least `threshold` of the element is on screen (for autoplay). */
function useInView<T extends Element>(ref: React.RefObject<T>, enabled: boolean, threshold = 0.6): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return setInView(false);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, threshold]);
  return inView;
}

const Veil = ({ label }: { label: string }) => (
  <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white pointer-events-none">
    {label}
  </span>
);

/** One image: small thumbnail first, full content if the thumbnail fails. */
const Img = ({ m, blurred, onFail }: { m: FeedMedia; blurred: boolean; onFail?: () => void }) => {
  const [src, setSrc] = useState(m.thumb ?? m.src);
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      // Whole image, natural aspect, capped at 70vh; never cropped (owner, 6 Oct 2026: tall images were cut).
      className="block w-full h-auto max-h-[70vh] object-contain"
      style={blurred ? { filter: 'blur(24px)' } : undefined}
      onError={() => {
        if (src !== m.src) setSrc(m.src);
        else onFail?.();
      }}
    />
  );
};

/** Images as a horizontally swipeable gallery (scroll-snap), blurred until tapped when `blur`. */
export const Gallery = ({
  images,
  blur,
  onFallback,
}: {
  images: FeedMedia[];
  blur: boolean;
  onFallback?: (m: FeedMedia) => void;
}) => {
  const [shown, setShown] = useState(!blur);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const ok = images.filter((m) => !failed.has(m.src));
  if (!ok.length) return null;
  const many = ok.length > 1;
  return (
    <div
      className="relative mt-2 overflow-hidden rounded-2xl"
      style={{ border: `1px solid ${LINE}` }}
      onClick={(e) => {
        stop(e);
        setShown(true);
      }}
    >
      <div
        className="flex items-center overflow-x-auto snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none', background: '#000' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAt(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
      >
        {ok.map((m) => (
          <div key={m.src.slice(0, 120)} className="w-full shrink-0 snap-center">
            <Img
              m={m}
              blurred={!shown}
              onFail={() => {
                setFailed((f) => new Set(f).add(m.src));
                if (m.guessed) onFallback?.(m);
              }}
            />
          </div>
        ))}
      </div>
      {!shown && <Veil label={many ? `Tap to show ${ok.length} images` : 'Tap to show image'} />}
      {many && shown && (
        <span
          className="absolute top-2 right-2 rounded-full px-2 py-[2px] text-[11px] font-bold text-white"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        >
          {Math.min(at + 1, ok.length)}/{ok.length}
        </span>
      )}
    </div>
  );
};

/**
 * Video. No src (so no download) until it plays; unloaded far off-screen. Tap to play, or, with
 * Settings → Feed → Video autoplay on, it starts muted once mostly on screen and pauses when scrolled
 * away. Blurred (unreviewed) videos never autoplay.
 */
export const VideoView = ({ m, blur }: { m: FeedMedia; blur: boolean }) => {
  const [{ autoplay }] = usePrefs();
  const [shown, setShown] = useState(!blur);
  const [playing, setPlaying] = useState(false);
  const [auto, setAuto] = useState(false);
  const [ref, near] = useNearView<HTMLDivElement>();
  const inView = useInView(ref, autoplay && shown);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!near && playing) setPlaying(false); // unmounts the <video>, releasing its buffer
  }, [near, playing]);
  useEffect(() => {
    if (!autoplay || !shown) return;
    if (inView && !playing) {
      setAuto(true);
      setPlaying(true);
    } else if (inView) void video.current?.play().catch(() => undefined);
    else if (playing) video.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, autoplay, shown]);
  return (
    <div
      ref={ref}
      className="relative mt-2 overflow-hidden rounded-2xl"
      style={{ border: `1px solid ${LINE}`, background: '#000', aspectRatio: '16 / 9' }}
      onClick={stop}
    >
      {playing ? (
        <video
          ref={video}
          src={m.src}
          poster={m.poster ?? undefined}
          controls
          autoPlay
          muted={auto}
          playsInline
          preload="none"
          className="w-full h-full"
          onError={() => setPlaying(false)}
        />
      ) : (
        <button
          className="absolute inset-0 w-full h-full"
          aria-label={shown ? 'Play video' : 'Show video'}
          onClick={() => {
            if (!shown) return setShown(true);
            setAuto(false);
            setPlaying(true);
          }}
        >
          {m.poster && (
            <img
              src={m.poster}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
              style={shown ? undefined : { filter: 'blur(24px)' }}
            />
          )}
          {shown ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-full p-3" style={{ background: 'rgba(0,0,0,0.6)' }}>
                <Play size={28} color="white" fill="white" />
              </span>
            </span>
          ) : (
            <Veil label="Tap to show video" />
          )}
        </button>
      )}
    </div>
  );
};

/** Audio row: a play button; the <audio> element (and its download) only exists after tapping. */
export const AudioRow = ({ m }: { m: FeedMedia }) => {
  const [on, setOn] = useState(false);
  const [ref, near] = useNearView<HTMLDivElement>();
  useEffect(() => {
    if (!near && on) setOn(false);
  }, [near, on]);
  return (
    <div
      ref={ref}
      className="mt-2 flex items-center gap-2 rounded-2xl px-3 py-2"
      style={{ border: `1px solid ${LINE}`, background: PANEL }}
      onClick={stop}
    >
      <Music size={18} color={MUTED} />
      {on ? (
        <audio src={m.src} controls autoPlay preload="none" className="flex-1 h-9" onError={() => setOn(false)} />
      ) : (
        <button
          className="flex flex-1 items-center gap-2 text-[13px] text-white"
          onClick={() => setOn(true)}
          aria-label="Play audio"
        >
          <Play size={16} color="white" fill="white" /> Play audio
        </button>
      )}
    </div>
  );
};

const open = (url: string) => (e: MouseEvent) => {
  stop(e);
  void openDappBrowser(url);
};

/** YouTube lite thumbnail (opens in the in-app browser), Vimeo / plain link cards. No page fetches, except OG previews of our own sites (unfurl.ts). */
export const LinkCard = ({ l, blur }: { l: LinkEmbed; blur: boolean }) => {
  const [shown, setShown] = useState(!blur);
  if (l.kind === 'youtube')
    return (
      <div
        className="relative mt-2 overflow-hidden rounded-2xl"
        style={{ border: `1px solid ${LINE}`, aspectRatio: '16 / 9', background: '#000' }}
      >
        <button
          className="absolute inset-0 w-full h-full"
          aria-label={shown ? 'Open YouTube video' : 'Show YouTube preview'}
          onClick={(e) => {
            if (!shown) {
              stop(e);
              return setShown(true);
            }
            open(l.url)(e);
          }}
        >
          <img
            src={l.thumb}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            style={shown ? undefined : { filter: 'blur(24px)' }}
          />
          {shown ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-xl px-4 py-2" style={{ background: 'rgba(220,0,0,0.9)' }}>
                <Play size={22} color="white" fill="white" />
              </span>
            </span>
          ) : (
            <Veil label="Tap to show YouTube preview" />
          )}
        </button>
      </div>
    );
  if (l.kind === 'link' && isOwnHost(l.url)) return <OwnLinkCard l={l} />;
  const host = l.kind === 'vimeo' ? 'vimeo.com' : l.host;
  const label = l.kind === 'vimeo' ? 'Vimeo video' : decodeURI(l.url.replace(/^https?:\/\/(www\.)?/, '')).slice(0, 80);
  return (
    <button
      onClick={open(l.url)}
      className="mt-2 flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left"
      style={{ border: `1px solid ${LINE}`, background: PANEL }}
    >
      {l.kind === 'vimeo' ? <Play size={18} color={MUTED} /> : <ExternalLink size={18} color={MUTED} />}
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-bold text-white truncate">{host}</span>
        <span className="block text-[11px] truncate" style={{ color: MUTED }}>
          {label}
        </span>
      </span>
    </button>
  );
};

/** A link to one of our own sites: OG image + title from bit-sign's unfurl, plain card until it loads. */
const OwnLinkCard = ({ l }: { l: Extract<LinkEmbed, { kind: 'link' }> }) => {
  const [og, setOg] = useState<OgPreview | null>(null);
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    let live = true;
    void ownLinkPreview(l.url).then((p) => live && setOg(p));
    return () => {
      live = false;
    };
  }, [l.url]);
  const label = decodeURI(l.url.replace(/^https?:\/\/(www\.)?/, '')).slice(0, 80);
  return (
    <button
      onClick={open(l.url)}
      className="mt-2 block w-full overflow-hidden rounded-2xl text-left"
      style={{ border: `1px solid ${LINE}`, background: PANEL }}
    >
      {og?.image && imgOk && (
        <img
          src={og.image}
          alt=""
          loading="lazy"
          className="block w-full object-cover"
          style={{ aspectRatio: '1200 / 630' }}
          onError={() => setImgOk(false)}
        />
      )}
      <span className="flex items-center gap-3 px-3 py-2">
        {!og?.image || !imgOk ? <ExternalLink size={18} color={MUTED} /> : null}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] truncate" style={{ color: MUTED }}>
            {og?.site ?? l.host}
          </span>
          <span className="block text-[12px] font-bold text-white truncate">{og?.title ?? label}</span>
          {og?.description && (
            <span className="block text-[11px] truncate" style={{ color: MUTED }}>
              {og.description}
            </span>
          )}
        </span>
      </span>
    </button>
  );
};

/** All media + links of a post. `blur` for syndicated sources (images, posters, previews). */
export const PostMedia = ({ media, links, blur }: { media: FeedMedia[]; links: LinkEmbed[]; blur: boolean }) => {
  // Guessed ordinals that turn out not to be images become plain links to their content.
  const [fallbacks, setFallbacks] = useState<LinkEmbed[]>([]);
  const images = media.filter((m) => m.kind === 'image');
  return (
    <>
      {images.length > 0 && (
        <Gallery
          images={images}
          blur={blur}
          onFallback={(m) => setFallbacks((f) => [...f, { kind: 'link', url: m.src, host: 'ordfs.network' }])}
        />
      )}
      {media
        .filter((m) => m.kind === 'video')
        .slice(0, 2)
        .map((m) => (
          <VideoView key={m.src} m={m} blur={blur} />
        ))}
      {media
        .filter((m) => m.kind === 'audio')
        .slice(0, 4)
        .map((m) => (
          <AudioRow key={m.src.slice(0, 120)} m={m} />
        ))}
      {[...links, ...fallbacks].map((l) => (
        <LinkCard key={l.url} l={l} blur={blur} />
      ))}
    </>
  );
};
