import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Sparkles } from 'lucide-react';
import type { MediaItem } from '../media/useWalletMedia';
import { localInscription } from '../media/nftViewer';
import { contentUrls } from '../market/indexer';
import { useServiceContext } from '../../hooks/useServiceContext';
import { captureVideoFrame } from './cardVideoFrame';
import type { CardPictureSource } from './cardLibrary';

/** The clip's bytes as a blob: URL (see cardVideoFrame.ts for why we never stream it). Null when unavailable. */
async function clipBlob(m: MediaItem, wallet: Parameters<typeof localInscription>[0]): Promise<Blob | null> {
  if (m.pending) {
    const ins = await localInscription(wallet, m.output);
    return ins?.data.length
      ? new Blob([ins.data as Uint8Array<ArrayBuffer>], { type: m.type || ins.contentType })
      : null;
  }
  for (const url of [m.url, ...contentUrls(m.origin)]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.blob();
    } catch {
      // next host
    }
  }
  return null;
}

/**
 * Frame picker for a video NFT (owner, 12 Oct 2026): the clip edge to edge with a scrubber; "Use this frame" hands
 * a JPEG of the current frame (and where it came from) back to the card designer.
 */
export function CardFramePicker({
  m,
  onUse,
  onClose,
}: {
  m: MediaItem;
  onUse: (uri: string, src: CardPictureSource) => void;
  onClose: () => void;
}) {
  const { apiContext } = useServiceContext();
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState('');
  const v = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    let made = '';
    setSrc(undefined);
    clipBlob(m, apiContext.wallet)
      .then((b) => {
        if (!live) return;
        if (!b) return setSrc(null);
        made = URL.createObjectURL(b);
        setSrc(made);
      })
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [m, apiContext.wallet]);

  const seek = (s: number) => {
    const el = v.current;
    if (!el) return;
    el.pause();
    el.currentTime = s;
    setT(s);
  };
  const use = () => {
    const el = v.current;
    if (!el) return;
    el.pause();
    try {
      onUse(captureVideoFrame(el), { origin: m.origin, t: Math.round(el.currentTime * 100) / 100 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That frame couldn’t be used.');
    }
  };

  return (
    <div className="bw-cdes-frame" role="dialog" aria-modal="true" aria-label={`Pick a frame from ${m.name}`}>
      <div className="bw-cdes-top">
        <b>Pick a frame</b>
      </div>
      <div className="bw-cdes-framevid">
        {src ? (
          <video
            ref={v}
            src={src}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              setDur(Number.isFinite(d) ? d : 0);
              e.currentTarget.currentTime = Math.min(0.1, d || 0);
            }}
            onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          <div className="bw-cdes-framegold">
            <Sparkles size={36} color="#F5B800" className={src === undefined ? 'animate-pulse' : ''} />
            <span>{src === undefined ? 'Opening your clip…' : 'This clip can’t be opened yet'}</span>
          </div>
        )}
      </div>
      <div className="bw-cdes-framebar">
        <button
          type="button"
          className="bw-cdes-x"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={!src}
          onClick={() => {
            const el = v.current;
            if (el) void (el.paused ? el.play().catch(() => undefined) : el.pause());
          }}
        >
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </button>
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.01}
          value={Math.min(t, dur || 0)}
          disabled={!src || !dur}
          aria-label="Frame"
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="bw-cdes-framet">{t.toFixed(1)}s</span>
      </div>
      {err && (
        <p className="bw-cdes-imgerr" role="alert">
          {err}
        </p>
      )}
      <div className="bw-cdes-actions">
        <button type="button" className="bw-cdes-reset" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="bw-cdes-done" onClick={use} disabled={!src || !dur}>
          Use this frame
        </button>
      </div>
    </div>
  );
}
