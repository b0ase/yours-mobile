import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { FileText, Image as ImageIcon, Paperclip, Play, X } from 'lucide-react';
import { ROOM_UPLOAD_MAX_BYTES, type BchatClient } from './api';
import type { ChatMessage } from './messages';
import { VideoEmbed } from '../feed/VideoEmbed';
import { formatSize, mediaPayload, messageVideo } from './roomMediaInfo';

/**
 * Photos and videos in chat rooms, and video links in messages.
 *
 *  - MessageVideo: the first YouTube / Vimeo / video-file link in a message as a click-to-play
 *    player (feed/VideoEmbed: nothing loads from YouTube until the tap).
 *  - RoomMediaBubble: an attachment (bit-sign `kind: 'media'`). Bytes are member-gated, so
 *    they are fetched with the session only when shown: images straight away, video and audio
 *    on tap. Nothing autoplays.
 *  - AttachButton: pick a photo or video, see its size against the 25 MB limit and that rooms
 *    are free, then Send. Progress shows while it uploads. Browser builds only.
 */
const GOLD = 'var(--bw-accent-hi)';
const LINE = '#1f2127';
const PANEL = '#121316';
const MUTED = '#8a8f98';

export const MessageVideo = ({ body }: { body: string | null | undefined }) => {
  const v = messageVideo(body);
  return v ? <VideoEmbed video={v} compact /> : null;
};

export const RoomMediaBubble = ({
  client,
  ticker,
  message,
}: {
  client: BchatClient;
  ticker: string;
  message: ChatMessage;
}) => {
  const p = mediaPayload(message);
  const mime = (p?.mime || '').toLowerCase();
  const kind = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const urlRef = useRef<string | null>(null);

  const load = async () => {
    if (!p?.media_id || state === 'loading' || url) return;
    setState('loading');
    try {
      const blob = await client.mediaBlob(ticker, p.media_id, mime);
      const u = URL.createObjectURL(blob);
      urlRef.current = u;
      setUrl(u);
      setState('idle');
    } catch {
      setState('error');
    }
  };
  useEffect(() => {
    if (kind === 'image') void load();
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.media_id]);

  if (!p) return null;
  const name = p.filename || 'Attachment';
  const size = typeof p.byte_size === 'number' ? formatSize(p.byte_size) : '';

  if (kind === 'image')
    return url ? (
      <img src={url} alt={name} className="block rounded-xl mb-1" style={{ maxHeight: '18rem', maxWidth: '100%' }} />
    ) : (
      <div
        className="flex items-center gap-2 py-6 px-4 rounded-xl mb-1 text-[12px]"
        style={{ background: 'rgba(0,0,0,0.25)' }}
      >
        <ImageIcon size={16} /> {state === 'error' ? 'Could not load photo' : 'Loading photo…'}
      </div>
    );

  if ((kind === 'video' || kind === 'audio') && url)
    return kind === 'video' ? (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        className="block rounded-xl mb-1 bg-black"
        style={{ maxHeight: '60vh', maxWidth: '100%' }}
      />
    ) : (
      <audio src={url} controls preload="metadata" className="block mb-1" style={{ maxWidth: '17rem' }} />
    );

  return (
    <button
      type="button"
      onClick={() => (kind === 'file' ? undefined : void load())}
      disabled={kind === 'file'}
      className="flex items-center gap-3 rounded-xl px-3 py-3 mb-1 text-left min-w-[14rem]"
      style={{ background: 'rgba(0,0,0,0.3)' }}
      aria-label={kind === 'file' ? name : `Play ${name}`}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: '#000', border: `1px solid color-mix(in srgb, ${GOLD} 40%, transparent)` }}
      >
        {kind === 'file' ? <FileText size={18} color={GOLD} /> : <Play size={18} color={GOLD} fill={GOLD} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">{name}</span>
        <span className="block text-[11px] opacity-70">
          {state === 'loading'
            ? 'Loading…'
            : state === 'error'
              ? 'Could not load. Tap to retry.'
              : kind === 'file'
                ? `${size}${size ? ' · ' : ''}open the room on bChatX to view`
                : `${kind === 'video' ? 'Video' : 'Audio'}${size ? ` · ${size}` : ''} · tap to play`}
        </span>
      </span>
    </button>
  );
};

/** Paperclip → pick → confirm sheet (size, limit, free) → upload with progress. Browser builds only. */
export const AttachButton = ({
  client,
  ticker,
  onUploaded,
  disabled,
}: {
  client: BchatClient;
  ticker: string;
  onUploaded: () => void;
  disabled?: boolean;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  if (Capacitor.isNativePlatform()) return null;

  const tooBig = !!picked && picked.size > ROOM_UPLOAD_MAX_BYTES;
  const send = async () => {
    if (!picked || tooBig) return;
    setError('');
    setProgress(0);
    try {
      await client.uploadMedia(ticker, picked, setProgress);
      setPicked(null);
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setProgress(null);
    }
  };
  const isVideo = picked?.type.startsWith('video/');

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*,video/mp4,video/webm,video/quicktime"
        hidden
        onChange={(e) => {
          setError('');
          setPicked(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={disabled || progress !== null}
        aria-label="Send a photo or video"
        title={`Send a photo or video (up to ${ROOM_UPLOAD_MAX_BYTES / 1024 / 1024} MB)`}
        className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <Paperclip size={18} color={MUTED} />
      </button>
      {picked && (
        <div className="fixed inset-0 z-[120] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
          <div
            className="w-full max-w-md rounded-t-2xl p-4 pb-6"
            style={{ background: '#0b0b0b', border: `1px solid ${LINE}` }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-[15px] font-bold text-white">Send {isVideo ? 'video' : 'photo'}</span>
              <button type="button" aria-label="Cancel" onClick={() => progress === null && setPicked(null)}>
                <X size={20} color={MUTED} />
              </button>
            </div>
            <div className="text-[13px] text-white truncate">{picked.name}</div>
            <div className="text-[12px] mt-1" style={{ color: tooBig ? '#ff7a7a' : MUTED }}>
              {formatSize(picked.size)} of {ROOM_UPLOAD_MAX_BYTES / 1024 / 1024} MB max
              {tooBig
                ? ' · too large for a room. Share a YouTube link instead.'
                : ' · free · only members of this room can see it'}
            </div>
            {progress !== null && (
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full" style={{ background: PANEL }}>
                <div
                  className="h-full"
                  style={{ width: `${Math.round(progress * 100)}%`, background: GOLD, transition: 'width 0.3s' }}
                />
              </div>
            )}
            {error && (
              <div className="mt-2 text-[12px]" style={{ color: '#ff7a7a' }}>
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={() => void send()}
              disabled={tooBig || progress !== null}
              className="mt-4 w-full rounded-full py-3 text-[15px] font-bold disabled:opacity-40"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : 'Send'}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
