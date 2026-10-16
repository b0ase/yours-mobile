import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { IS_EXTENSION } from '../extension';
import { YoursNative, isNative } from '../native';
import { mediaPermissionState, openPermissionTab } from '../permissions/extensionMedia';
import { isPermissionDenied } from '../permissions/mediaPermission';
import { voiceNote, type VoiceFail } from './voiceText';

/**
 * Speech to text for "hold the b to talk to b" (phone/Dock.tsx; owner, 8 Oct 2026).
 * - iOS / Android apps: YoursNative speech* (SFSpeechRecognizer on-device where it can / SpeechRecognizer).
 *   WKWebView has no Web Speech API, and the community plugin has no Swift Package, so it is in-repo.
 * - Web wallet and the Chrome extension: the Web Speech API, feature-detected, plus a mic analyser for the bars.
 *   The extension's side panel can't show Chrome's mic prompt: the first time, the permissions.html tab opens.
 * Nothing here sends anything to b: the transcript goes to the composer, and AgentConversation's send()
 * (consent, price, confirm) does the rest.
 */
export type VoiceHandlers = { onText: (t: string) => void; onLevel: (l: number) => void };
export type VoiceSession = { stop: () => Promise<string>; cancel: () => void };
export type VoiceStart = { ok: true; session: VoiceSession } | { ok: false; reason: VoiceFail; note: string };

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
const RecCtor = (): (new () => Rec) | undefined => {
  const w = globalThis as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

const platform = () => (IS_EXTENSION ? 'extension' : isNative ? (Capacitor.getPlatform() as 'ios' | 'android') : 'web');
const fail = (reason: VoiceFail): VoiceStart => ({ ok: false, reason, note: voiceNote(reason, platform()) });

let nativeAvail: boolean | null = null;
/** Can this device listen at all? Cached; the Dock checks it on mount so the hold knows what to do. */
export async function voiceSupported(): Promise<boolean> {
  if (!isNative) return !!RecCtor();
  if (nativeAvail === null)
    nativeAvail = await YoursNative.speechAvailable().then(
      (r) => r.available,
      () => false,
    );
  return nativeAvail;
}

export const hapticTick = () => {
  void YoursNative.haptic?.().catch(() => navigator.vibrate?.(15));
};

async function startNative(h: VoiceHandlers): Promise<VoiceStart> {
  const subs: PluginListenerHandle[] = [];
  const drop = () => subs.splice(0).forEach((s) => void s.remove());
  subs.push(await YoursNative.addListener('speechPartial', (e) => h.onText(e.text)));
  subs.push(await YoursNative.addListener('speechLevel', (e) => h.onLevel(e.level)));
  const r = await YoursNative.speechStart().catch(() => ({ started: false, reason: 'error' as const }));
  if (!r.started) {
    drop();
    return fail(r.reason === 'denied' ? 'denied' : r.reason === 'asked' ? 'asked' : 'unavailable');
  }
  return {
    ok: true,
    session: {
      stop: async () => {
        const out = await YoursNative.speechStop().catch(() => ({ text: '' }));
        drop();
        return out.text;
      },
      cancel: () => {
        drop();
        void YoursNative.speechCancel().catch(() => undefined);
      },
    },
  };
}

/**
 * Safari (and Chrome on Android) only let recognition start inside a user gesture, and the hold timer
 * fires outside it. So on the web the press itself primes a recogniser: created and start()ed synchronously
 * in pointerdown/touchstart, nothing awaited first. A tap or cancel aborts it; a hold hands it to startWeb.
 * Results that arrive before startWeb takes over are buffered.
 */
type Primed = { rec: Rec; text: string; error: string | null; ended: boolean; onEnd: (() => void) | null };
let primed: Primed | null = null;
const canPrime = () => !isNative && !IS_EXTENSION && !!RecCtor();

/** Call synchronously from the press handler. Returns false when nothing was primed. */
export function primeVoice(): boolean {
  unprimeVoice();
  if (!canPrime()) return false;
  const Ctor = RecCtor()!;
  try {
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    const p: Primed = { rec, text: '', error: null, ended: false, onEnd: null };
    rec.onresult = (e) => {
      p.text = Array.from(e.results, (r) => r[0]?.transcript ?? '')
        .join('')
        .trim();
    };
    rec.onerror = (e) => {
      p.error = e.error;
    };
    rec.onend = () => {
      p.ended = true;
      p.onEnd?.();
    };
    rec.start();
    primed = p;
    return true;
  } catch {
    primed = null;
    return false;
  }
}

/** Tap, cancel or unmount before the hold: drop the primed recogniser. */
export function unprimeVoice() {
  const p = primed;
  primed = null;
  if (!p) return;
  try {
    p.rec.abort();
  } catch {
    /* already stopped */
  }
}

const recError = (e: string | null): VoiceFail | null =>
  e === 'not-allowed' || e === 'service-not-allowed' ? 'denied' : e === 'audio-capture' ? 'unavailable' : null;

async function startWeb(h: VoiceHandlers): Promise<VoiceStart> {
  const Ctor = RecCtor();
  if (!Ctor) return fail('unavailable');
  if (IS_EXTENSION && (await mediaPermissionState('mic')) !== 'granted') {
    openPermissionTab(['mic'], { once: true });
    return fail('asked');
  }
  const pre = primed;
  primed = null;
  if (pre) {
    const bad = recError(pre.error);
    if (bad) return fail(bad);
  }
  // The level bars are optional: a second mic stream can fail (or be refused) while speech still works.
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (!pre) return fail(isPermissionDenied(e) ? 'denied' : 'unavailable');
  }
  if (pre) return runWeb(h, pre.rec, stream, pre);
  return runWeb(h, new Ctor(), stream, null);
}

function runWeb(h: VoiceHandlers, rec: Rec, stream: MediaStream | null, pre: Primed | null): VoiceStart {
  // Bars: an analyser on the mic (Web Speech gives no level).
  let ctx: AudioContext | null = null;
  let tick = 0;
  if (stream) {
    try {
      const c = new AudioContext();
      ctx = c;
      const an = c.createAnalyser();
      an.fftSize = 512;
      c.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      tick = window.setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        h.onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      }, 80);
    } catch {
      /* no bars */
    }
  }
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let text = pre?.text ?? '';
  if (text) h.onText(text);
  let ended: (() => void) | null = null;
  rec.onresult = (e) => {
    text = Array.from(e.results, (r) => r[0]?.transcript ?? '')
      .join('')
      .trim();
    h.onText(text);
  };
  rec.onerror = () => undefined;
  rec.onend = () => ended?.();
  const release = () => {
    window.clearInterval(tick);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => undefined);
  };
  // A primed recogniser is already running (started inside the press); otherwise start one now.
  if (!pre) {
    try {
      rec.start();
    } catch {
      release();
      return fail('unavailable');
    }
  }
  return {
    ok: true,
    session: {
      stop: () =>
        new Promise<string>((resolve) => {
          const done = () => {
            release();
            resolve(text);
          };
          ended = done;
          window.setTimeout(done, 1200);
          rec.stop();
        }),
      cancel: () => {
        release();
        rec.abort();
      },
    },
  };
}

export const startVoice = (h: VoiceHandlers): Promise<VoiceStart> => (isNative ? startNative(h) : startWeb(h));
