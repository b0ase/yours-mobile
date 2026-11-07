/**
 * The chat composer's "+" sheet (owner, 4 Nov 2026: the condensed chatbar in the apps and the extension "needs a
 * solution for options rather than cramming them all into a second row of buttons"). PURE: which options a room
 * offers, why one is off, and which handler each runs. The sheet is chat/ComposerOptionsSheet.tsx.
 *
 * The bar stays one row: "+", the gold b, the text box (with its emoji button) and Send. Everything else is here.
 * An option that can't be used right now is shown greyed with the reason, never hidden (owner: pages show status).
 */

export type ComposerOptionId = 'photo' | 'file' | 'gif' | 'emoji' | 'voice' | 'call' | 'draft';

export type ComposerOption = {
  id: ComposerOptionId;
  label: string;
  hint: string;
  /** Why it can't be used now; undefined when it can. */
  off?: string;
};

/** What a call option does in this conversation. */
export type CallKind =
  /** A 1:1: ring the other person (bPhone, by their $handle's identity key). */
  | { kind: 'dm'; peer: string }
  /** A room with a live Space (or the always-open one): join it. */
  | { kind: 'join' }
  /** A room whose Space this person may start (issuer, admin, or an open stage). */
  | { kind: 'start' }
  | null;

export type ComposerContext = {
  online: boolean;
  /** Uploads are allowed here (free rooms: hidden where a message costs tokens). */
  uploads: boolean;
  /** This device can record audio (MediaRecorder + a microphone API). */
  canRecord: boolean;
  call: CallKind;
  /** "Ask b to draft an agreement" is offered in this room (chat/bDraft.ts). */
  draftable: boolean;
};

const PAID_ROOM = 'Not in rooms that charge per message';

export function composerOptions(c: ComposerContext): ComposerOption[] {
  const upload = !c.online ? 'Offline' : !c.uploads ? PAID_ROOM : undefined;
  const out: ComposerOption[] = [
    { id: 'photo', label: 'Photo or video', hint: 'Free · up to 25 MB', off: upload },
    { id: 'file', label: 'File', hint: 'Any file · 25 MB', off: upload },
    { id: 'gif', label: 'GIF', hint: 'Search GIPHY', off: c.online ? undefined : 'Offline' },
    { id: 'emoji', label: 'Emoji', hint: 'Add to your text' },
    {
      id: 'voice',
      label: 'Voice note',
      hint: 'Record and send',
      off: upload ?? (c.canRecord ? undefined : 'This device cannot record here'),
    },
    {
      id: 'call',
      label: callLabel(c.call),
      hint: callHint(c.call),
      off: !c.online ? 'Offline' : c.call ? undefined : 'Rooms: when a Space is live, or if you can host one',
    },
  ];
  if (c.draftable)
    out.push({
      id: 'draft',
      label: 'Draft with b',
      hint: 'Agreement or terms',
      off: c.online ? undefined : 'Offline',
    });
  return out;
}

const callLabel = (c: CallKind) =>
  c?.kind === 'dm'
    ? `Call $${c.peer}`
    : c?.kind === 'join'
      ? 'Join the Space'
      : c?.kind === 'start'
        ? 'Start a Space'
        : 'Call';

const callHint = (c: CallKind) =>
  c?.kind === 'dm'
    ? 'Voice call (bPhone)'
    : c?.kind === 'join'
      ? 'Live audio here'
      : c?.kind === 'start'
        ? 'Go live with audio'
        : 'Voice call or Space';

export type ComposerHandlers = Record<ComposerOptionId, () => void>;

/** Run an option's handler. False (and nothing runs) when the option is missing or off. */
export function runComposerOption(id: ComposerOptionId, options: ComposerOption[], h: ComposerHandlers): boolean {
  const o = options.find((x) => x.id === id);
  if (!o || o.off) return false;
  h[id]();
  return true;
}

/** Accept lists for the two pickers: "Photo or video" asks for media, "File" for anything. */
export const PHOTO_ACCEPT = 'image/*,video/*';
export const FILE_ACCEPT = '';
/** Files per send (bChatX allows many at once; one sheet keeps it to a handful). */
export const MAX_ATTACH = 10;

// ── Voice notes ──────────────────────────────────────────────────────────────────────────────

/** Longest voice note (bChatX's limit is the 25 MB file size; five minutes of Opus is well under it). */
export const VOICE_MAX_MS = 5 * 60 * 1000;

/** The recorder format: Opus in WebM (Chrome, Android, Firefox), else AAC in MP4 (Safari, iPhone). */
export function recorderMime(isTypeSupported: (mime: string) => boolean): string {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    try {
      if (isTypeSupported(m)) return m;
    } catch {
      /* an old engine that throws: try the next */
    }
  }
  return '';
}

/** "voice-2026-11-04-1530.webm" from the recorder's MIME type. */
export function voiceFileName(mime: string, now = new Date()): string {
  const ext = /mp4|aac|m4a/i.test(mime) ? 'm4a' : /ogg/i.test(mime) ? 'ogg' : 'webm';
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `voice-${stamp}.${ext}`;
}

/** "0:07", "2:30". */
export const clockLabel = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
