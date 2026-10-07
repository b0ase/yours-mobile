import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cachedSnapshot, snapshot, type SnapshotOpts } from './snapshot';

/**
 * A grid tile's picture of a 3D model: a still rendered once on the shared offscreen renderer (snapshot.ts),
 * started when the tile comes near the viewport. Skeleton while it renders, `fallback` if it can't.
 */
const ModelThumb = ({
  url,
  cacheKey,
  opts,
  fallback,
  alt = '',
}: {
  url: string;
  cacheKey?: string;
  opts?: SnapshotOpts;
  fallback: ReactNode;
  alt?: string;
}) => {
  const key = cacheKey ?? url;
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null | undefined>(() => cachedSnapshot(key));
  useEffect(() => {
    if (src !== undefined) return;
    const el = ref.current;
    if (!el) return;
    let live = true;
    const go = () =>
      snapshot(url, opts, key).then(
        (u) => live && setSrc(u),
        () => live && setSrc(null),
      );
    if (typeof IntersectionObserver === 'undefined') {
      void go();
    } else {
      const io = new IntersectionObserver(
        (es) => {
          if (es.some((e) => e.isIntersecting)) {
            io.disconnect();
            void go();
          }
        },
        { rootMargin: '200px' },
      );
      io.observe(el);
      return () => {
        live = false;
        io.disconnect();
      };
    }
    return () => {
      live = false;
    };
  }, [url, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="relative w-full h-full">
      {src ? (
        <img src={src} alt={alt} className="w-full h-full object-contain" draggable={false} />
      ) : src === null ? (
        fallback
      ) : (
        <div className="absolute inset-0 animate-pulse bg-[#1d2026]" />
      )}
    </div>
  );
};

export default ModelThumb;
