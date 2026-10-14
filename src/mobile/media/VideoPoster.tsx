import { useState } from 'react';
import { Video } from 'lucide-react';
import { contentUrls } from '../market/indexer';
import { useVideoPoster } from './videoCover';

const GOLD = 'var(--bw-accent)';

/** Gold video tile: icon, "Video" and the title (when there's room). Never a blank square. */
export const VideoFallback = ({ title, compact }: { title?: string; compact?: boolean }) => (
  <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-2 text-center bg-[#17191E]">
    <Video size={compact ? 16 : 28} style={{ color: GOLD }} />
    <span className="text-[10px] font-bold tracking-wide" style={{ color: GOLD }}>
      Video
    </span>
    {!compact && title && (
      <span className="text-[10px] font-semibold text-white line-clamp-2 break-words">{title}</span>
    )}
  </div>
);

/**
 * Preview for a video NFT: its embedded cover (<img>), else a first frame (`<video preload=metadata #t=0.1>`, muted,
 * shown only once a frame has loaded), with the gold Video tile underneath so nothing is ever blank.
 */
export const VideoPoster = ({
  outpoint,
  title,
  compact,
  className = 'w-full h-full object-cover',
}: {
  outpoint: string;
  title?: string;
  compact?: boolean;
  className?: string;
}) => {
  const poster = useVideoPoster(outpoint);
  const [badImg, setBadImg] = useState(false);
  const [frame, setFrame] = useState(false);
  const [badVideo, setBadVideo] = useState(false);
  const src = contentUrls(outpoint)[0];
  return (
    <div className="relative w-full h-full">
      <div className="absolute inset-0">
        <VideoFallback title={title} compact={compact} />
      </div>
      {poster && !badImg ? (
        <img src={poster} alt="" decoding="async" onError={() => setBadImg(true)} className={`relative ${className}`} />
      ) : (
        poster !== undefined &&
        src &&
        !badVideo && (
          <video
            src={`${src}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            onLoadedData={() => setFrame(true)}
            onError={() => setBadVideo(true)}
            className={`relative pointer-events-none ${className}`}
            style={{ opacity: frame ? 1 : 0 }}
          />
        )
      )}
    </div>
  );
};
