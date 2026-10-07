import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, EyeOff, FileText, Flag, Music, Play } from 'lucide-react';
import { documentLabel } from '../media/media';
import { contentUrls } from './indexer';
import { cachedThumb, loadThumb, thumbUrl } from './thumbs';
import { MARKET_ENABLED } from '../storeBuild';

/** True once the element has come within `margin` of the viewport (sticky). */
function useNearViewport<T extends Element>(margin = '400px') {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') return setNear(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

const Shimmer = () => <div className="absolute inset-0 animate-pulse bg-[#1d2026]" />;

/**
 * Card thumbnail: shimmer placeholder until near the viewport, then a small
 * resized WebP from the queue/cache (see thumbs.ts); falls back to the full
 * inscription hosts if the resize endpoint fails. Fills its (fixed-aspect) parent.
 */
export const Thumb = ({
  outpoint,
  alt = '',
  className = '',
}: {
  outpoint: string;
  alt?: string;
  className?: string;
}) => {
  const url = thumbUrl(outpoint);
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const [src, setSrc] = useState<string | null | undefined>(() => (url ? cachedThumb(url) : null));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!near || !url || src) return;
    let live = true;
    void loadThumb(url).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [near, url, src]);
  return (
    <div ref={ref} className="relative w-full h-full">
      {!loaded && <Shimmer />}
      {src ? (
        <img
          src={src}
          alt={alt}
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={`${className} transition-opacity duration-200`}
          style={{ opacity: loaded ? 1 : 0 }}
        />
      ) : (
        src === null &&
        near && <ContentImg outpoint={outpoint} alt={alt} className={className} onLoad={() => setLoaded(true)} />
      )}
    </div>
  );
};

/**
 * Media thumbnail behind the always-on blur: image and video previews are
 * blurred unless their collection is on the owner's allowlist, until the user
 * taps "Show". Only items that already passed the safety filter get here.
 */
export const Blurred = ({
  collectionId,
  forceBlur,
  children,
}: {
  collectionId?: string | null;
  forceBlur?: boolean;
  children: ReactNode;
}) => {
  const [shown, setShown] = useState(false);
  // Blocked items never reach the Market (the safety filter drops them), so only items the
  // filter flags (e.g. your own NFTs in Media) are blurred. Everything else shows as-is.
  void collectionId;
  const blur = !shown && !!forceBlur;
  return (
    <div className="relative w-full h-full overflow-hidden">
      <div className="w-full h-full" style={blur ? { filter: 'blur(18px)', transform: 'scale(1.15)' } : undefined}>
        {children}
      </div>
      {blur && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShown(true);
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/30 text-[11px] font-semibold text-white"
        >
          <EyeOff size={16} />
          {forceBlur ? 'Flagged · Show' : 'Show'}
        </button>
      )}
    </div>
  );
};

/** First working content host for an outpoint (steps through ORDFS fallbacks on error). */
export const ContentImg = ({
  outpoint,
  className,
  alt = '',
  onLoad,
}: {
  outpoint: string;
  className?: string;
  alt?: string;
  onLoad?: () => void;
}) => {
  const urls = contentUrls(outpoint);
  const [i, setI] = useState(0);
  if (i >= urls.length) return <div className={`${className ?? ''} bg-[#2b2f36]`} />;
  return (
    <img
      src={urls[i]}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={onLoad}
      onError={() => setI(i + 1)}
      className={className}
    />
  );
};

export type CardItem = {
  outpoint: string;
  origin: string;
  name: string;
  category: 'music' | 'video' | 'images' | 'documents' | '3d';
  /** Shown as the type badge on document tiles (PDF, TXT, DOCX...). */
  contentType?: string;
  collectionId: string | null;
  collectionName: string | null;
  collectionIcon: string | null;
  priceLabel: string;
  buyable: boolean;
};

export const NftCard = ({
  item,
  onBuy,
  onPlay,
  onOpen,
  onReport,
}: {
  item: CardItem;
  onBuy: () => void;
  onPlay: () => void;
  onOpen: () => void;
  onReport: () => void;
}) => {
  const src = contentUrls(item.origin)[0];
  const [videoRef, videoNear] = useNearViewport<HTMLDivElement>('200px');
  return (
    <div className="flex flex-col rounded-xl overflow-hidden bg-[#17191E] border border-white/5">
      <div
        className="relative w-full bg-[#0b0c0f]"
        style={{ aspectRatio: '1/1' }}
        onClick={item.category === 'music' ? onPlay : onOpen}
      >
        {item.category === 'images' && (
          <Blurred collectionId={item.collectionId}>
            <Thumb outpoint={item.origin} alt={item.name} className="w-full h-full object-cover" />
          </Blurred>
        )}
        {item.category === 'video' && (
          <Blurred collectionId={item.collectionId}>
            {/* first frame as poster, only once near the viewport: muted, no autoplay */}
            <div ref={videoRef} className="relative w-full h-full">
              <Shimmer />
              {videoNear && (
                <video
                  src={`${src}#t=0.1`}
                  muted
                  playsInline
                  preload="metadata"
                  className="relative w-full h-full object-cover pointer-events-none"
                />
              )}
            </div>
          </Blurred>
        )}
        {item.category === 'music' &&
          (item.collectionIcon ? (
            <Blurred collectionId={item.collectionId}>
              <Thumb outpoint={item.collectionIcon} className="w-full h-full object-cover" />
            </Blurred>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Music size={30} style={{ color: '#A1FF8B' }} />
            </div>
          ))}
        {item.category === 'documents' && (
          // No thumbnails for documents: file icon, title and a type badge. Tap opens it via ORDFS.
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
            <FileText size={34} style={{ color: '#FFD24D' }} />
            <span className="text-[11px] font-semibold text-white line-clamp-2 break-words">{item.name}</span>
            <span
              className="rounded-md px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
              style={{ background: '#2b2f36', color: '#FFD24D' }}
            >
              {documentLabel(item.contentType) ?? 'DOC'}
            </span>
          </div>
        )}
        {item.category === '3d' && (
          // GLB / glTF: no thumbnail (the model is the content). Tap opens the spinning viewer.
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-3 text-center">
            <Box size={34} style={{ color: '#F5B800' }} />
            <span className="text-[11px] font-semibold text-white line-clamp-2 break-words">{item.name}</span>
            <span
              className="rounded-md px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
              style={{ background: '#2b2f36', color: '#F5B800' }}
            >
              3D
            </span>
          </div>
        )}
        {(item.category === 'music' || item.category === 'video') && (
          <button
            aria-label={item.category === 'music' ? 'Play preview' : 'Preview video'}
            onClick={(e) => {
              e.stopPropagation();
              if (item.category === 'music') onPlay();
              else onOpen();
            }}
            className="absolute bottom-1.5 right-1.5 rounded-full bg-black/70 p-1.5"
          >
            <Play size={14} color="#fff" fill="#fff" />
          </button>
        )}
        <button
          aria-label="Report"
          onClick={(e) => {
            e.stopPropagation();
            onReport();
          }}
          className="absolute top-1.5 right-1.5 rounded-full bg-black/70 p-1.5"
        >
          <Flag size={12} color="#F97066" />
        </button>
      </div>
      <div className="px-2 pt-1.5 pb-2 flex flex-col gap-1">
        <div className="text-xs font-semibold text-white truncate">{item.name}</div>
        <div className="text-[10px] text-[#98A2B3] truncate">{item.collectionName ?? 'No collection'}</div>
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] font-semibold truncate" style={{ color: '#A1FF8B' }}>
            {item.priceLabel}
          </span>
          {item.buyable && MARKET_ENABLED && (
            <button
              onClick={onBuy}
              className="rounded-lg px-2.5 py-1 text-[11px] font-bold"
              style={{ background: '#A1FF8B', color: '#010101' }}
            >
              Buy
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
