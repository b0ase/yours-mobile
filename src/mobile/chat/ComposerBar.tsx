import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { ArrowUp, Plus, Smile, X } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { B_OUTLINE_D, B_OUTLINE_VIEWBOX } from '../brand/bOutline';
import type { BchatClient } from './api';
import { insertAtCursor, rememberEmoji } from './emoji';
import {
  composerOptions,
  FILE_ACCEPT,
  MAX_ATTACH,
  PHOTO_ACCEPT,
  runComposerOption,
  type CallKind,
  type ComposerOptionId,
} from './composerOptions';
import { AttachSheet, EmojiPanel, GifSheet, OptionsSheet, VoiceNoteSheet } from './ComposerSheets';

/**
 * The chat bar in the wallet's rooms and DMs: phone apps, Chrome extension, web and Desktop (owner, 4 Nov 2026).
 *
 *   [+]  [b]  [ Message…            ☺ ]  [↑]
 *
 * One row, never a second row of buttons. "+" opens the options sheet (photo or video, file, GIF, emoji, voice note,
 * call or Space, draft with b); ☺ opens the emoji panel, which inserts at the caret. The gold b stays on the bar:
 * it is how you ask $b ("Questions? Tap the gold b"), as on bChatX's bar.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const BAR_BG = '#0b0b0b';
const MAX_INPUT_PX = 128;

type Sheet = 'options' | 'gif' | 'voice' | null;

const coarsePointer = () => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

const canRecordHere = () =>
  typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export const ComposerBar = ({
  client,
  ticker,
  draft,
  setDraft,
  onDraftInput,
  onSend,
  onSendGif,
  inputRef,
  online,
  uploads,
  enterSends,
  onUploaded,
  call,
  onCall,
  draftable,
  onDraft,
  onAskB,
  askBLabel,
}: {
  client: Pick<BchatClient, 'uploadMedia' | 'gifSearch'>;
  ticker: string;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** Every edit of the text (typing indicator). */
  onDraftInput?: (text: string) => void;
  onSend: (text: string) => void;
  /** A picked GIF: sent at once as its link, leaving the typed text alone. */
  onSendGif: (url: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  online: boolean;
  /** Attachments allowed (off in rooms that charge per message). */
  uploads: boolean;
  /** Enter sends (keyboards); on phones Enter is a new line and the arrow sends. */
  enterSends: boolean;
  onUploaded: () => void;
  call: CallKind;
  /** Start the call or open the Space; resolves to an error to show, if any. */
  onCall: () => Promise<string | void> | void;
  draftable: boolean;
  onDraft: () => void;
  onAskB: () => void;
  askBLabel: string;
}) => {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [staged, setStaged] = useState<File[]>([]);
  const [notice, setNotice] = useState('');
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastPicker = useRef<'photo' | 'file'>('photo');
  // Where the caret was when the text box last had it: the emoji panel inserts there (it may have taken the focus).
  const sel = useRef<{ start: number | null; end: number | null }>({ start: null, end: null });
  const trackSel = () => {
    const el = inputRef.current;
    if (el) sel.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const options = useMemo(
    () => composerOptions({ online, uploads, canRecord: canRecordHere(), call, draftable }),
    [online, uploads, call, draftable],
  );

  const stage = (list: FileList | File[] | null | undefined) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    const next = [...staged, ...picked];
    if (next.length > MAX_ATTACH) setNotice(`Up to ${MAX_ATTACH} at a time. The rest were left out.`);
    setStaged(next.slice(0, MAX_ATTACH));
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const focused = !!el && document.activeElement === el;
    const start = focused ? el.selectionStart : sel.current.start;
    const end = focused ? el.selectionEnd : sel.current.end;
    const r = insertAtCursor(draft, start, end, emoji);
    setDraft(r.value);
    onDraftInput?.(r.value);
    sel.current = { start: r.caret, end: r.caret };
    rememberEmoji(emoji);
    requestAnimationFrame(() => {
      const t = inputRef.current;
      if (!t) return;
      // On a phone the panel stands in for the keyboard: focusing would bring the keyboard up over it.
      if (!coarsePointer()) t.focus();
      try {
        t.setSelectionRange(r.caret, r.caret);
      } catch {
        /* not focusable yet */
      }
    });
  };

  const pick = (id: ComposerOptionId) => {
    setSheet(null);
    runComposerOption(id, options, {
      // The file pickers open inside the tap (Safari drops a picker opened later).
      photo: () => {
        lastPicker.current = 'photo';
        photoInput.current?.click();
      },
      file: () => {
        lastPicker.current = 'file';
        fileInput.current?.click();
      },
      gif: () => setSheet('gif'),
      emoji: () => setEmojiOpen(true),
      voice: () => setSheet('voice'),
      call: () => {
        void Promise.resolve(onCall()).then((err) => err && setNotice(err));
      },
      draft: onDraft,
    });
  };

  // The text box grows with what you type, up to about five lines, then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, MAX_INPUT_PX)}px`;
    el.style.overflowY = el.scrollHeight + 2 > MAX_INPUT_PX ? 'auto' : 'hidden';
  }, [draft, inputRef]);

  const search = useCallback((q: string) => client.gifSearch(q), [client]);
  const upload = (file: File, onProgress: (f: number) => void) => client.uploadMedia(ticker, file, onProgress);

  return (
    // `relative`: on wider screens the emoji panel is a popover above the bar (ComposerSheets EmojiPanel).
    <div className="relative shrink-0">
      {notice && (
        <div
          className="flex items-start gap-2 px-4 pt-2 text-[12px] shrink-0"
          style={{ background: BAR_BG, color: '#f5c46b' }}
          role="status"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice('')} className="shrink-0">
            <X size={14} color={MUTED} />
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend(draft);
        }}
        className="bw-composer flex items-end gap-2 px-3 pt-2 shrink-0"
        style={{ paddingBottom: 8, background: BAR_BG, borderTop: `1px solid ${LINE}` }}
      >
        <button
          type="button"
          onClick={() => setSheet(sheet === 'options' ? null : 'options')}
          aria-label="More: photo, file, GIF, emoji, voice note, call"
          aria-haspopup="dialog"
          aria-expanded={sheet === 'options'}
          title="More"
          className="bw-composer-plus h-10 w-10 rounded-full flex items-center justify-center shrink-0"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        >
          <Plus
            size={22}
            color={GOLD}
            strokeWidth={2.4}
            style={{ transform: sheet === 'options' ? 'rotate(45deg)' : undefined, transition: 'transform 0.15s' }}
          />
        </button>
        <button
          type="button"
          onClick={onAskB}
          aria-label={askBLabel}
          title="Ask b"
          className="bw-composer-b h-10 w-10 rounded-full flex items-center justify-center shrink-0"
          style={{
            background: '#1a1608',
            color: GOLD,
            border: `1px solid color-mix(in srgb, ${GOLD} 33%, transparent)`,
          }}
        >
          {/* The gold b mark (owner, 18 Oct 2026); the white/edition themes swap in the outline b. */}
          <img src={bGlyph} alt="" width={22} height={22} draggable={false} className="bw-dock-b-gold" />
          <svg
            className="bw-dock-b-outline"
            width={22}
            height={22}
            viewBox={B_OUTLINE_VIEWBOX}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d={B_OUTLINE_D} vectorEffect="non-scaling-stroke" />
          </svg>
        </button>
        <div className="relative flex-1 min-w-0">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onDraftInput?.(e.target.value);
              trackSel();
            }}
            onSelect={trackSel}
            onKeyUp={trackSel}
            onClick={trackSel}
            onFocus={() => {
              // Phones: the keyboard comes up, so the emoji panel steps aside.
              if (coarsePointer()) setEmojiOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && enterSends && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend(draft);
              } else if (e.key === 'Escape' && emojiOpen) setEmojiOpen(false);
            }}
            onPaste={(e) => {
              // A pasted screenshot or file becomes an attachment (web, extension, Desktop).
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length || !uploads || !online) return;
              e.preventDefault();
              stage(files);
            }}
            rows={1}
            maxLength={4000}
            placeholder={online ? 'Message' : 'Offline'}
            aria-label="Message"
            className="bw-composer-input block w-full resize-none overflow-hidden rounded-2xl py-[9px] pl-4 pr-11 text-[15px] leading-[1.35] text-white outline-none"
            style={{
              background: PANEL,
              border: `1px solid ${emojiOpen ? `color-mix(in srgb, ${GOLD} 45%, transparent)` : LINE}`,
            }}
          />
          <button
            type="button"
            // Mouse: keep the caret where it is.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              trackSel();
              setEmojiOpen((v) => !v);
            }}
            aria-label="Emoji"
            aria-pressed={emojiOpen}
            title="Emoji"
            className="absolute right-1 bottom-1 h-8 w-8 rounded-full flex items-center justify-center"
          >
            <Smile size={21} color={emojiOpen ? GOLD : MUTED} />
          </button>
        </div>
        <button
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
          className="bw-composer-send h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
          style={{ background: GOLD }}
        >
          <ArrowUp size={20} color="#1a1300" strokeWidth={2.6} />
        </button>
      </form>
      {emojiOpen && <EmojiPanel onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}

      <input
        ref={photoInput}
        type="file"
        accept={PHOTO_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          stage(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept={FILE_ACCEPT || undefined}
        multiple
        hidden
        onChange={(e) => {
          stage(e.target.files);
          e.target.value = '';
        }}
      />

      {sheet === 'options' && <OptionsSheet options={options} onPick={pick} onClose={() => setSheet(null)} />}
      {sheet === 'gif' && (
        <GifSheet
          search={search}
          onClose={() => setSheet(null)}
          onPick={(url) => {
            setSheet(null);
            onSendGif(url);
          }}
        />
      )}
      {sheet === 'voice' && (
        <VoiceNoteSheet
          onClose={() => setSheet(null)}
          onSend={async (file) => {
            await upload(file, () => undefined);
            onUploaded();
          }}
        />
      )}
      {staged.length > 0 && (
        <AttachSheet
          files={staged}
          onRemove={(i) => setStaged((cur) => cur.filter((_, j) => j !== i))}
          onAddMore={
            staged.length < MAX_ATTACH
              ? () => (lastPicker.current === 'file' ? fileInput : photoInput).current?.click()
              : null
          }
          upload={upload}
          onDone={() => {
            setStaged([]);
            onUploaded();
          }}
          onClose={() => setStaged([])}
        />
      )}
    </div>
  );
};
