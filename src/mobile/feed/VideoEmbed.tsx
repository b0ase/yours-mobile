import { useState, type MouseEvent } from 'react';
import { Capacitor } from '@capacitor/core';
import { Play } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import {
  EMBED_ALLOW,
  EMBED_SANDBOX,
  embedSrc,
  fileSrc,
  knownThumb,
  providerLabel,
  startLabel,
  type VideoLink,
} from './video-embed';

/**
 * Click-to-play video for feed posts and chat rooms (same rules as bChatX's VideoEmbed):
 * thumbnail + play button; the player iframe is created only when the viewer taps play
 * (youtube-nocookie, Vimeo dnt, sandboxed, lazy), so nothing autoplays and no third party
 * loads before the tap. No page fetches: YouTube thumbnails come straight from i.ytimg.com.
 *
 * In the phone apps YouTube refuses to play inside the app's webview (it has no web origin to
 * send as a referrer), so there the tap opens the video in the in-app browser instead.
 */
const LINE = '#1f2127';
const GOLD = '#FFD24D';

const stop = (e: MouseEvent) => e.stopPropagation();

export const VideoEmbed = ({
  video,
  blur = false,
  compact = false,
}: {
  video: VideoLink;
  blur?: boolean;
  compact?: boolean;
}) => {
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(!blur);
  const [thumbOk, setThumbOk] = useState(true);
  const native = Capacitor.isNativePlatform();
  const width = compact ? 'min(18rem, 100%)' : '100%';

  if (video.provider === 'file') {
    return (
      <div
        className="mt-2 overflow-hidden rounded-2xl"
        style={{ border: `1px solid ${LINE}`, background: '#000', width }}
        onClick={stop}
      >
        {shown ? (
          <video
            src={fileSrc(video)}
            controls
            preload="metadata"
            playsInline
            className="block w-full"
            style={{ maxHeight: '60vh' }}
          />
        ) : (
          <button className="block w-full py-10 text-[12px] text-white" onClick={() => setShown(true)}>
            Tap to show video
          </button>
        )}
      </div>
    );
  }

  const src = embedSrc(video);
  const thumb = thumbOk ? knownThumb(video) : null;
  const label = `${providerLabel(video.provider)}${video.live ? ' · Live' : ''}${video.start ? ` · from ${startLabel(video.start)}` : ''}`;
  const onTap = (e: MouseEvent) => {
    stop(e);
    if (!shown) return setShown(true);
    if (native) return void openDappBrowser(video.url);
    setPlaying(true);
  };

  return (
    <div
      className="relative mt-2 overflow-hidden rounded-2xl"
      style={{
        border: `1px solid ${LINE}`,
        background: '#000',
        width,
        aspectRatio: video.portrait ? '9 / 16' : '16 / 9',
        maxHeight: video.portrait ? '70vh' : undefined,
      }}
      onClick={stop}
    >
      {playing && src ? (
        <iframe
          src={src}
          title={`${providerLabel(video.provider)} video`}
          className="absolute inset-0 h-full w-full"
          sandbox={EMBED_SANDBOX}
          allow={EMBED_ALLOW}
          allowFullScreen
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{ border: 0 }}
        />
      ) : (
        <button
          className="absolute inset-0 h-full w-full"
          aria-label={shown ? `Play ${providerLabel(video.provider)} video` : 'Show video preview'}
          onClick={onTap}
        >
          {thumb && (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setThumbOk(false)}
              className="h-full w-full object-cover"
              style={shown ? undefined : { filter: 'blur(24px)' }}
            />
          )}
          <span
            className="absolute inset-0"
            style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.7), transparent 55%)' }}
          />
          {shown ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{ background: 'rgba(0,0,0,0.7)', border: `1px solid ${GOLD}88` }}
              >
                <Play size={22} color={GOLD} fill={GOLD} />
              </span>
            </span>
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-[12px] font-bold text-white">
              Tap to show video preview
            </span>
          )}
          <span className="absolute bottom-2 left-3 text-[11px] text-white" style={{ textShadow: '0 1px 2px #000' }}>
            {label}
          </span>
        </button>
      )}
    </div>
  );
};
