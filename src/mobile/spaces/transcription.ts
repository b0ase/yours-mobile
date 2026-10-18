/**
 * Space transcription with consent — the wallet side of bit-sign `space-transcription-rules.ts`.
 *
 * Off by default. The host picks Off / Transcribe / Transcribe + track agreements. Listeners see a
 * notice before joining; speakers tick a separate box before taking the mic, or choose "Don't
 * transcribe me" and speak untranscribed, labelled "(not transcribed)". Withdrawing stops their
 * recording at once. Audio is deleted straight after transcription. Only the Space's speakers and
 * host can read the transcript, and each speaker can delete their own lines.
 */

export type TranscriptionMode = 'off' | 'transcribe' | 'agreements';

export const TRANSCRIPTION_MODES: { mode: TranscriptionMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Nobody is transcribed.' },
  { mode: 'transcribe', label: 'Transcribe', hint: 'Speakers who agree are turned into text.' },
  { mode: 'agreements', label: 'Transcribe + agreements', hint: 'Also tracks what speakers agree to.' },
];

export const TRANSCRIBING_BADGE = 'Transcribing';
export const NOT_TRANSCRIBED = '(not transcribed)';
export const DEFAULT_LISTEN_NOTICE =
  'This Space is being transcribed. Speakers who agree are turned into text; listeners are not recorded. ' +
  'Audio is deleted as soon as it is transcribed, and only the speakers and host can read the transcript.';
export const DEFAULT_SPEAK_NOTICE =
  'Transcribe my voice while I speak. My audio is deleted straight after it is turned into text. ' +
  "Only this Space's speakers and host can read it, and I can delete my own lines or stop at any time.";

export interface Transcription {
  mode: TranscriptionMode;
  badge: string | null;
  listenNotice: string;
  speakNotice: string;
  notTranscribed: string[];
  me: { listen: boolean; speak: boolean };
}

export const OFF: Transcription = {
  mode: 'off',
  badge: null,
  listenNotice: DEFAULT_LISTEN_NOTICE,
  speakNotice: DEFAULT_SPEAK_NOTICE,
  notTranscribed: [],
  me: { listen: false, speak: false },
};

const norm = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();

export const parseMode = (v: unknown): TranscriptionMode => (v === 'transcribe' || v === 'agreements' ? v : 'off');

/** `transcription` from a Space GET / action reply. Missing or malformed reads as off. */
export const parseTranscription = (v: unknown): Transcription => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o) return OFF;
  const mode = parseMode(o.mode);
  const me = o.me && typeof o.me === 'object' ? (o.me as Record<string, unknown>) : {};
  return {
    mode,
    badge: mode === 'off' ? null : TRANSCRIBING_BADGE,
    listenNotice: typeof o.listen_notice === 'string' && o.listen_notice ? o.listen_notice : DEFAULT_LISTEN_NOTICE,
    speakNotice: typeof o.speak_notice === 'string' && o.speak_notice ? o.speak_notice : DEFAULT_SPEAK_NOTICE,
    notTranscribed:
      mode === 'off' || !Array.isArray(o.not_transcribed)
        ? []
        : o.not_transcribed.filter((h): h is string => typeof h === 'string').map(norm),
    me: { listen: me.listen === true, speak: me.speak === true },
  };
};

/** Show the listen notice: transcription on and I have not acknowledged it in this Space. */
export const needsListenNotice = (t: Transcription, anonymous: boolean) =>
  t.mode !== 'off' && !anonymous && !t.me.listen;

/**
 * Ask before the mic goes live: transcription on, I am on stage and have not answered yet.
 * `answered` = I already chose "Don't transcribe me" in this Space (kept client-side).
 * Never in a store build (`enabled` false): there the mic just works, untranscribed.
 */
export const needsSpeakChoice = (t: Transcription, o: { enabled: boolean; answered: boolean }) =>
  o.enabled && t.mode !== 'off' && !t.me.speak && !o.answered;

export const isNotTranscribed = (t: Transcription, handle: string) => t.notTranscribed.includes(norm(handle));

export interface TranscriptLine {
  id: string;
  handle: string;
  tStart: string | null;
  text: string | null;
  redacted: boolean;
}

export const parseTranscript = (v: unknown): TranscriptLine[] => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const rows = o && Array.isArray(o.utterances) ? o.utterances : [];
  return rows
    .map((r): TranscriptLine | null => {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
      if (!x || typeof x.id !== 'string' || typeof x.handle !== 'string') return null;
      const redacted = x.redacted === true || !!x.redacted_at;
      return {
        id: x.id,
        handle: norm(x.handle),
        tStart: typeof x.t_start === 'string' ? x.t_start : null,
        text: redacted ? null : typeof x.text === 'string' ? x.text : null,
        redacted,
      };
    })
    .filter((l): l is TranscriptLine => !!l);
};

/** Only my own, not-yet-deleted lines get a Delete button. */
export const mayRedactLine = (line: TranscriptLine, me: string) => !line.redacted && line.handle === norm(me);
