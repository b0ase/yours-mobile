/** Pure text for hold-to-talk (tested in voiceText.test.ts). */
export type VoiceFail = 'unavailable' | 'denied' | 'asked' | 'empty';
export type VoicePlatform = 'ios' | 'android' | 'web' | 'extension';

/** The short note b's page shows when voice didn't produce a message; the keyboard is up instead. */
export function voiceNote(reason: VoiceFail, platform: VoicePlatform): string {
  if (reason === 'empty') return 'Didn’t catch that. Type to b, or hold the b and try again.';
  if (reason === 'asked')
    return platform === 'extension'
      ? 'Allow the microphone in the tab that opened, then hold the b again to talk.'
      : 'Microphone allowed. Hold the b again to talk.';
  if (reason === 'denied') {
    if (platform === 'ios')
      return 'Voice is off for bWallet. Turn on Microphone and Speech Recognition in iPhone Settings › Apps › bWallet. You can type to b meanwhile.';
    if (platform === 'android')
      return 'Voice is off for bWallet. Allow the microphone in Android Settings › Apps › bWallet › Permissions. You can type to b meanwhile.';
    return 'The microphone is blocked here. Allow it in your browser’s site settings, or type to b.';
  }
  if (platform === 'web') return 'Voice isn’t available in this browser; type instead.';
  return 'Voice isn’t available on this device. Type to b instead.';
}

/** A transcript worth sending: something other than spaces. */
export const usableTranscript = (t: string) => t.replace(/\s+/g, ' ').trim();

/** The "no voice in this browser" note shows once per device; after that a hold just opens b with the keyboard. */
const NO_VOICE_SEEN = 'bw.noVoiceNote';
export function firstNoVoiceNote(store: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocal()): boolean {
  try {
    if (!store) return true;
    if (store.getItem(NO_VOICE_SEEN)) return false;
    store.setItem(NO_VOICE_SEEN, '1');
  } catch {
    /* storage blocked: show it */
  }
  return true;
}
const safeLocal = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
