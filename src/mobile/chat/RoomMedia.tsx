import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Download, FileText, Image as ImageIcon, Play } from 'lucide-react';
import type { BchatClient } from './api';
import type { ChatMessage } from './messages';
import { formatSize, mediaPayload } from './roomMediaInfo';

/**
 * Attachments in chat rooms: RoomMediaBubble draws one (bit-sign `kind: 'media'`). Bytes are member-gated, so
 * they are fetched with the session only when shown: images straight away, video and audio on tap, other files
 * on tap to save (browser builds). Nothing autoplays. Sending lives in the chat bar (chat/ComposerBar.tsx), and
 * link previews in chat/MessageLinks.tsx.
 */
const GOLD = 'var(--bw-accent-hi)';

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
  // Other files: saved to this computer on tap (web, extension, Desktop). The phone apps have no download folder
  // to hand a blob to, so there the file opens from the room on bChatX.
  const savable = kind === 'file' && !Capacitor.isNativePlatform();
  const save = async () => {
    if (!p.media_id || state === 'loading') return;
    setState('loading');
    try {
      const blob = await client.mediaBlob(ticker, p.media_id, mime);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
      setState('idle');
    } catch {
      setState('error');
    }
  };

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
      onClick={() => (kind === 'file' ? savable && void save() : void load())}
      disabled={kind === 'file' && !savable}
      className="flex items-center gap-3 rounded-xl px-3 py-3 mb-1 text-left min-w-[14rem]"
      style={{ background: 'rgba(0,0,0,0.3)' }}
      aria-label={kind === 'file' ? (savable ? `Save ${name}` : name) : `Play ${name}`}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: '#000', border: `1px solid color-mix(in srgb, ${GOLD} 40%, transparent)` }}
      >
        {kind !== 'file' ? (
          <Play size={18} color={GOLD} fill={GOLD} />
        ) : savable ? (
          <Download size={18} color={GOLD} />
        ) : (
          <FileText size={18} color={GOLD} />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">{name}</span>
        <span className="block text-[11px] opacity-70">
          {state === 'loading'
            ? 'Loading…'
            : state === 'error'
              ? 'Could not load. Tap to retry.'
              : kind === 'file'
                ? `${size}${size ? ' · ' : ''}${savable ? 'tap to save' : 'open the room on bChatX to view'}`
                : `${kind === 'video' ? 'Video' : 'Audio'}${size ? ` · ${size}` : ''} · tap to play`}
        </span>
      </span>
    </button>
  );
};
