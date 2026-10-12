import { bHold, B_HOLD_IDLE, B_HOLD_MS, type BHoldEvent, type BHoldPhase, type BHoldState } from '../phone/gesture';
import type { VoiceHandlers, VoiceStart } from './voice';
import { usableTranscript, voiceNote, type VoicePlatform } from './voiceText';

/**
 * Press-and-hold-to-talk on a b button: one implementation shared by the Dock's b and the Ask b composer's b.
 * Gesture rules live in gesture.ts (bHold): tap · hold B_HOLD_MS = listen · release = done · slide away = cancel.
 * This controller adds the voice session and the sheet state; the React side is useHoldToTalk.
 */
export type TalkSheet = { text: string; level: number; note?: string; sending?: boolean };

export type HoldToTalkResult = { text: string } | { note: string };

export type HoldToTalkOptions = {
  /** A short press (or keyboard activation). */
  onTap: () => void;
  /** The hold started (after the haptic tick). `supported` is false when this device can't take voice. */
  onListen?: (supported: boolean) => void;
  /** Released while listening: the transcript, or a note saying why there isn't one. */
  onResult: (r: HoldToTalkResult) => void;
  /** Released on a device without voice (still inside the user gesture, so focus works on iOS). */
  onUnsupportedRelease: () => void;
  /** Cancelled (slide away, Escape, touch cancel, app hidden). */
  onCancel?: () => void;
  onChange: (phase: BHoldPhase, sheet: TalkSheet | null) => void;
  start: (h: VoiceHandlers) => Promise<VoiceStart>;
  /** null = not known yet (treated as supported; startVoice reports the real reason). */
  supported: () => boolean | null;
  haptic: () => void;
  platform?: VoicePlatform;
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
};

export function createHoldToTalk(o: HoldToTalkOptions) {
  const setT = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let hold: BHoldState = B_HOLD_IDLE;
  let timer: unknown = null;
  let sheet: TalkSheet | null = null;
  let legacy = false;
  let voice: Promise<VoiceStart> | null = null;
  let alive = true;

  const emit = () => alive && o.onChange(hold.phase, sheet);
  const setSheet = (f: (s: TalkSheet | null) => TalkSheet | null) => {
    sheet = f(sheet);
    emit();
  };
  const stopTimer = () => {
    if (timer !== null) clearT(timer);
    timer = null;
  };
  const cancelVoice = () => {
    const v = voice;
    voice = null;
    setSheet(() => null);
    void v?.then((r) => r.ok && r.session.cancel());
  };
  const finish = async () => {
    const v = voice;
    voice = null;
    if (!v) return setSheet(() => null);
    setSheet((s) => (s ? { ...s, sending: true } : s));
    const r = await v;
    const text = r.ok ? usableTranscript(await r.session.stop()) : '';
    setSheet(() => null);
    if (!alive) return;
    o.onResult(text ? { text } : { note: r.ok ? voiceNote('empty', o.platform ?? 'web') : r.note });
  };

  const dispatch = (e: BHoldEvent) => {
    const r = bHold(hold, e);
    hold = r.state;
    if (hold.phase === 'idle') stopTimer();
    emit();
    switch (r.effect) {
      case 'home':
        return o.onTap();
      case 'listen': {
        o.haptic();
        legacy = o.supported() === false;
        o.onListen?.(!legacy);
        if (legacy) return;
        setSheet(() => ({ text: '', level: 0 }));
        voice = o.start({
          onText: (text) => setSheet((s) => (s ? { ...s, text } : s)),
          onLevel: (level) => setSheet((s) => (s ? { ...s, level } : s)),
        });
        void voice.then((v) => !v.ok && setSheet((s) => (s ? { ...s, note: v.note } : s)));
        return;
      }
      case 'send':
        if (legacy) return o.onUnsupportedRelease();
        return void finish();
      case 'cancel':
        if (!legacy) cancelVoice();
        return o.onCancel?.();
    }
  };

  return {
    phase: () => hold.phase,
    sheet: () => sheet,
    down(x: number, y: number) {
      if (hold.phase !== 'idle') return;
      dispatch({ type: 'down', x, y });
      stopTimer();
      timer = setT(() => {
        timer = null;
        dispatch({ type: 'timer' });
      }, o.holdMs ?? B_HOLD_MS);
    },
    move: (x: number, y: number) => dispatch({ type: 'move', x, y }),
    up: () => dispatch({ type: 'up' }),
    abort: () => dispatch({ type: 'abort' }),
    dispose() {
      stopTimer();
      cancelVoice();
      alive = false;
    },
  };
}
export type HoldToTalk = ReturnType<typeof createHoldToTalk>;
