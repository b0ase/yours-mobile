import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  PenLine,
  Phone,
  Radio,
  Search,
  Smile,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { IS_EXTENSION } from '../extension';
import { mediaPermissionState, openPermissionTab } from '../permissions/extensionMedia';
import { ROOM_UPLOAD_MAX_BYTES, type GifResult } from './api';
import { EMOJI_GROUPS, readRecentEmoji } from './emoji';
import {
  clockLabel,
  recorderMime,
  VOICE_MAX_MS,
  voiceFileName,
  type ComposerOption,
  type ComposerOptionId,
} from './composerOptions';
import { formatSize } from './roomMediaInfo';

/**
 * The chat composer's panels (chat/ComposerBar.tsx owns which one is open):
 *  - OptionsSheet: the "+" sheet (chat/composerOptions.ts decides what is in it and what is off).
 *  - EmojiPanel: a local emoji grid docked above the bar; the bar inserts at the caret.
 *  - GifSheet: GIPHY search through bit-sign's proxy; picking one sends its link (drawn as the GIF).
 *  - VoiceNoteSheet: record, listen back, send as an audio attachment.
 *  - AttachSheet: the picked photos, videos or files, previewed, then sent to the room.
 * Gold on near-black like the rest of Chat; sheets sit over the room view (z-[110]).
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const BAD = '#ff7a7a';

/** A bottom sheet over the room; a centred card in the wide layout (max-w-md). */
export const ComposerSheet = ({
  title,
  onClose,
  children,
  label,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  label?: string;
}) =>
  createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
    >
      <div
        className="bw-composer-sheet w-full max-w-md rounded-t-2xl px-4 pt-3"
        style={{
          background: '#0b0b0b',
          border: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ background: '#2a2b30' }} aria-hidden />
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[15px] font-bold text-white">{title}</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 rounded-full active:opacity-60">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );

const OPTION_ICON: Record<ComposerOptionId, ReactNode> = {
  photo: <ImageIcon size={20} />,
  file: <Paperclip size={20} />,
  gif: <span className="text-[12px] font-extrabold tracking-tight">GIF</span>,
  emoji: <Smile size={20} />,
  voice: <Mic size={20} />,
  call: <Phone size={20} />,
  draft: <PenLine size={20} />,
};

/** The "+" sheet: one tile per option, greyed with its reason when it can't be used here. */
export const OptionsSheet = ({
  options,
  onPick,
  onClose,
}: {
  options: ComposerOption[];
  onPick: (id: ComposerOptionId) => void;
  onClose: () => void;
}) => (
  <ComposerSheet title="Add to your message" label="Message options" onClose={onClose}>
    <div className="grid grid-cols-3 gap-2" role="menu">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="menuitem"
          data-option={o.id}
          onClick={() => !o.off && onPick(o.id)}
          aria-disabled={!!o.off}
          title={o.off ?? o.hint}
          className="flex flex-col items-center gap-1.5 rounded-2xl px-2 py-3 text-center active:opacity-70"
          style={{ background: PANEL, border: `1px solid ${LINE}`, opacity: o.off ? 0.45 : 1 }}
        >
          <span
            className="flex h-11 w-11 items-center justify-center rounded-full"
            style={{
              background: '#1a1608',
              color: GOLD,
              border: `1px solid color-mix(in srgb, ${GOLD} 33%, transparent)`,
            }}
          >
            {o.id === 'call' && /Space/.test(o.label) ? <Radio size={20} /> : OPTION_ICON[o.id]}
          </span>
          <span className="text-[13px] font-semibold leading-tight text-white">{o.label}</span>
          <span className="text-[10.5px] leading-snug" style={{ color: MUTED }}>
            {o.off ?? o.hint}
          </span>
        </button>
      ))}
    </div>
  </ComposerSheet>
);

/** The emoji grid, docked above the bar like a keyboard. Recent ones first (this device only). */
export const EmojiPanel = ({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) => {
  const [recent] = useState(readRecentEmoji);
  const groups = useMemo(
    () =>
      recent.length
        ? [{ id: 'recent', label: 'Recent', icon: '🕘', emoji: recent }, ...EMOJI_GROUPS]
        : [...EMOJI_GROUPS],
    [recent],
  );
  // Recent first once there are a few; until then the smileys.
  const [tab, setTab] = useState(recent.length >= 8 ? 'recent' : EMOJI_GROUPS[0].id);
  const shown = groups.find((x) => x.id === tab) ?? groups[0];
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    grid.current?.scrollTo?.({ top: 0 });
  }, [tab]);
  return (
    <div
      // Phones and the extension: docked under the bar like a keyboard. Wider: a popover above the bar, at its right.
      className="bw-emoji-panel shrink-0 border-t border-[#1f2127] sm:absolute sm:bottom-full sm:right-3 sm:z-20 sm:mb-2 sm:w-[400px] sm:overflow-hidden sm:rounded-2xl sm:border sm:shadow-2xl"
      role="dialog"
      aria-label="Emoji"
      style={{ background: '#0b0b0b' }}
    >
      {/* One row that always fits (no sideways scrolling): the tabs share the width. */}
      <div className="flex items-center gap-0.5 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Emoji groups">
          {groups.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={x.id === shown.id}
              aria-label={x.label}
              title={x.label}
              onClick={() => setTab(x.id)}
              className="h-9 min-w-0 flex-1 rounded-full text-[17px] leading-none"
              style={{
                background: x.id === shown.id ? '#1a1608' : 'transparent',
                border: `1px solid ${x.id === shown.id ? `color-mix(in srgb, ${GOLD} 40%, transparent)` : 'transparent'}`,
              }}
            >
              {x.icon}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close emoji"
          className="h-9 w-8 shrink-0 rounded-full flex items-center justify-center"
        >
          <X size={18} color={MUTED} />
        </button>
      </div>
      <div className="px-3 pt-1 text-[11px] font-semibold" style={{ color: MUTED }}>
        {shown.label}
      </div>
      <div
        ref={grid}
        className="grid gap-0.5 overflow-y-auto px-2 pb-2"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))', height: 'min(208px, 30vh)' }}
      >
        {shown.emoji.map((e) => (
          <button
            key={e}
            type="button"
            // Mouse: keep the caret in the text box (no blur before the insert).
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e)}
            aria-label={`Insert ${e}`}
            className="bw-emoji h-10 rounded-lg text-[26px] leading-none active:scale-90"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
};

/** GIF search (trending first). Picking one sends it straight away, as bChatX does. */
export const GifSheet = ({
  search,
  onPick,
  onClose,
}: {
  search: (q: string) => Promise<GifResult[]>;
  onPick: (url: string) => void;
  onClose: () => void;
}) => {
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<GifResult[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    const query = q.trim();
    const t = setTimeout(
      () => {
        setErr('');
        search(query)
          .then((g) => live && setGifs(g))
          .catch(() => {
            if (!live) return;
            setGifs([]);
            setErr('Could not load GIFs right now.');
          });
      },
      query ? 350 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, search]);
  return (
    <ComposerSheet title="GIF" onClose={onClose}>
      <label
        className="mb-3 flex items-center gap-2 rounded-full px-3"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <Search size={16} color={MUTED} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search GIPHY"
          aria-label="Search GIFs"
          className="h-10 flex-1 bg-transparent text-[15px] text-white outline-none"
        />
      </label>
      {err && (
        <div className="mb-2 text-[12px]" style={{ color: BAD }}>
          {err}
        </div>
      )}
      <div className="grid grid-cols-3 gap-1" style={{ minHeight: 160 }}>
        {gifs === null && (
          <div className="col-span-3 flex items-center justify-center py-10" style={{ color: MUTED }}>
            <Loader2 size={20} className="animate-spin" />
          </div>
        )}
        {gifs?.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onPick(g.url)}
            aria-label="Send this GIF"
            className="overflow-hidden rounded-lg"
            style={{ background: PANEL, aspectRatio: '1 / 1' }}
          >
            <img
              src={g.preview}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          </button>
        ))}
        {gifs?.length === 0 && !err && (
          <div className="col-span-3 py-8 text-center text-[13px]" style={{ color: MUTED }}>
            No GIFs found
          </div>
        )}
      </div>
      <div className="mt-2 text-right text-[10px]" style={{ color: MUTED }}>
        Powered by GIPHY
      </div>
    </ComposerSheet>
  );
};

type VoiceState =
  | { at: 'idle' }
  | { at: 'asked' }
  | { at: 'recording'; since: number }
  | { at: 'done'; file: File; url: string; ms: number }
  | { at: 'error'; text: string };

/** Record a voice note, listen back, send it as an audio attachment. Starts recording on open. */
export const VoiceNoteSheet = ({ onSend, onClose }: { onSend: (file: File) => Promise<void>; onClose: () => void }) => {
  const [s, setS] = useState<VoiceState>({ at: 'idle' });
  const [now, setNow] = useState(Date.now());
  const [sending, setSending] = useState(false);
  const rec = useRef<{ r: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string; since: number } | null>(
    null,
  );
  const release = () => {
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  };
  const start = async () => {
    if (IS_EXTENSION && (await mediaPermissionState('mic')) !== 'granted') {
      // The side panel can't show Chrome's prompt: a tab of the extension asks, then Record works here.
      openPermissionTab(['mic']);
      setS({ at: 'asked' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = recorderMime((m) => MediaRecorder.isTypeSupported(m));
      const r = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const since = Date.now();
      const cur = { r, stream, chunks: [] as Blob[], mime: r.mimeType || mime || 'audio/webm', since };
      r.ondataavailable = (e) => e.data.size && cur.chunks.push(e.data);
      r.onstop = () => {
        release();
        const blob = new Blob(cur.chunks, { type: cur.mime });
        const file = new File([blob], voiceFileName(cur.mime), { type: cur.mime });
        setS({ at: 'done', file, url: URL.createObjectURL(blob), ms: Date.now() - cur.since });
      };
      rec.current = cur;
      r.start(1000);
      setS({ at: 'recording', since });
    } catch {
      setS({ at: 'error', text: 'Microphone not available. Allow it for bWalletX in your settings.' });
    }
  };
  const stop = () => {
    if (rec.current?.r.state === 'recording') rec.current.r.stop();
  };
  useEffect(() => {
    void start();
    return () => {
      if (rec.current?.r.state === 'recording') {
        rec.current.r.onstop = null;
        rec.current.r.stop();
      }
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (s.at !== 'recording') return;
    const id = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - s.since >= VOICE_MAX_MS) stop();
    }, 250);
    return () => clearInterval(id);
  }, [s]);
  useEffect(() => () => void (s.at === 'done' && URL.revokeObjectURL(s.url)), [s]);

  const send = async () => {
    if (s.at !== 'done') return;
    setSending(true);
    try {
      await onSend(s.file);
      onClose();
    } catch (e) {
      setS({ at: 'error', text: e instanceof Error ? e.message : 'Could not send' });
    } finally {
      setSending(false);
    }
  };

  return (
    <ComposerSheet title="Voice note" onClose={onClose}>
      <div className="flex flex-col items-center gap-3 py-2">
        {s.at === 'recording' && (
          <>
            <span className="flex items-center gap-2 text-[28px] font-bold tabular-nums text-white">
              <span className="h-3 w-3 animate-pulse rounded-full" style={{ background: '#ff4d3d' }} />
              {clockLabel(now - s.since)}
            </span>
            <span className="text-[12px]" style={{ color: MUTED }}>
              Recording · up to {clockLabel(VOICE_MAX_MS)}
            </span>
            <button
              type="button"
              onClick={stop}
              aria-label="Stop recording"
              className="mt-1 flex h-14 w-14 items-center justify-center rounded-full"
              style={{ background: GOLD }}
            >
              <Square size={20} color="#1a1300" fill="#1a1300" />
            </button>
          </>
        )}
        {s.at === 'done' && (
          <>
            <audio src={s.url} controls preload="metadata" className="w-full" />
            <span className="text-[12px]" style={{ color: MUTED }}>
              {clockLabel(s.ms)} · {formatSize(s.file.size)} · only members of this room can hear it
            </span>
            <div className="flex w-full gap-2">
              <button
                type="button"
                onClick={() => void start()}
                disabled={sending}
                className="flex flex-1 items-center justify-center gap-2 rounded-full py-3 text-[14px] font-semibold disabled:opacity-40"
                style={{ background: PANEL, border: `1px solid ${LINE}`, color: '#f2f2f2' }}
              >
                <Trash2 size={16} /> Record again
              </button>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending}
                className="flex-1 rounded-full py-3 text-[15px] font-bold disabled:opacity-40"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
        {(s.at === 'idle' || s.at === 'asked' || s.at === 'error') && (
          <>
            <span className="text-center text-[13px]" style={{ color: s.at === 'error' ? BAD : MUTED }}>
              {s.at === 'asked'
                ? 'Allow the microphone in the tab that just opened, then tap Record.'
                : s.at === 'error'
                  ? s.text
                  : 'Starting the microphone…'}
            </span>
            {s.at !== 'idle' && (
              <button
                type="button"
                onClick={() => void start()}
                className="flex h-14 w-14 items-center justify-center rounded-full"
                style={{ background: GOLD }}
                aria-label="Record"
              >
                <Mic size={22} color="#1a1300" />
              </button>
            )}
          </>
        )}
      </div>
    </ComposerSheet>
  );
};

/** One picked file's preview: the picture, the video's first frame, or a file card. */
const AttachThumb = ({ file }: { file: File }) => {
  const url = useMemo(() => (/^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (url && file.type.startsWith('image/'))
    return <img src={url} alt={file.name} className="h-full w-full object-cover" />;
  if (url) return <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />;
  return (
    <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
      <FileText size={22} color={GOLD} />
      <span className="w-full truncate text-[10px]" style={{ color: MUTED }}>
        {file.name.split('.').pop()?.toUpperCase().slice(0, 6) || 'FILE'}
      </span>
    </span>
  );
};

/** Picked files → preview → Send (one at a time, with progress), as bChatX's room upload does. */
export const AttachSheet = ({
  files,
  onRemove,
  onAddMore,
  upload,
  onDone,
  onClose,
}: {
  files: File[];
  onRemove: (i: number) => void;
  onAddMore: (() => void) | null;
  upload: (file: File, onProgress: (f: number) => void) => Promise<void>;
  onDone: () => void;
  onClose: () => void;
}) => {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const tooBig = files.filter((f) => f.size > ROOM_UPLOAD_MAX_BYTES);
  const busy = progress !== null;
  const send = async () => {
    if (!files.length || tooBig.length) return;
    setError('');
    let sent = 0;
    try {
      for (const f of files) {
        await upload(f, (p) => setProgress((sent + p) / files.length));
        sent++;
      }
      onDone();
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : 'Upload failed'}${sent ? ` (${sent} of ${files.length} sent)` : ''}`,
      );
      for (let i = 0; i < sent; i++) onRemove(0);
    } finally {
      setProgress(null);
    }
  };
  const kinds = new Set(
    files.map((f) => (f.type.startsWith('image/') ? 'photo' : f.type.startsWith('video/') ? 'video' : 'file')),
  );
  const what =
    files.length === 1
      ? [...kinds][0]
      : kinds.size === 1
        ? `${files.length} ${[...kinds][0]}s`
        : `${files.length} attachments`;
  return (
    <ComposerSheet title={`Send ${what}`} onClose={() => !busy && onClose()}>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {files.map((f, i) => (
          <div key={`${f.name}-${i}`} className="relative shrink-0">
            <div
              className="h-24 w-24 overflow-hidden rounded-xl"
              style={{
                background: PANEL,
                border: `1px solid ${f.size > ROOM_UPLOAD_MAX_BYTES ? BAD : LINE}`,
              }}
            >
              <AttachThumb file={f} />
            </div>
            {!busy && (
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemove(i)}
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full"
                style={{ background: '#000', border: `1px solid ${LINE}` }}
              >
                <X size={13} color="#fff" />
              </button>
            )}
            <div className="mt-1 w-24 truncate text-[10.5px]" style={{ color: MUTED }} title={f.name}>
              {f.name}
            </div>
          </div>
        ))}
        {onAddMore && !busy && (
          <button
            type="button"
            onClick={onAddMore}
            aria-label="Add more"
            className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl text-[28px]"
            style={{ background: PANEL, border: `1px dashed ${LINE}`, color: MUTED }}
          >
            +
          </button>
        )}
      </div>
      <div className="mt-2 text-[12px]" style={{ color: tooBig.length ? BAD : MUTED }}>
        {formatSize(files.reduce((n, f) => n + f.size, 0))} · up to {ROOM_UPLOAD_MAX_BYTES / 1024 / 1024} MB each
        {tooBig.length
          ? ` · ${tooBig.length === 1 ? 'one is' : `${tooBig.length} are`} too large. Share a link instead.`
          : ' · free · only members of this room can see them'}
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
        <div className="mt-2 text-[12px]" style={{ color: BAD }}>
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => void send()}
        disabled={!files.length || !!tooBig.length || busy}
        className="mt-4 w-full rounded-full py-3 text-[15px] font-bold disabled:opacity-40"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {progress !== null ? `Sending… ${Math.round(progress * 100)}%` : 'Send'}
      </button>
    </ComposerSheet>
  );
};
