import { Capacitor } from '@capacitor/core';
import { YoursNative } from '../native';
import { IS_EXTENSION } from '../extension';
import { mediaPermissionState, openPermissionTab } from './extensionMedia';
import { needsTabGrant, toMediaPlatform, type MediaKind } from './mediaPermission';

/**
 * iOS: ask AVFoundation for the device first, so the system prompt appears (and the switch exists
 * in Settings) rather than WebKit refusing silently. Throws NotAllowedError when refused, which the
 * screens turn into the Open Settings note. Android/web: getUserMedia itself prompts.
 */
export async function ensureMediaAccess(kind: MediaKind): Promise<void> {
  // The Sent! chime sets WebKit's audio session to 'ambient', which blocks capture
  // ("AudioSession category is not compatible with audio capture"). Recording needs play-and-record.
  if (kind === 'mic') setAudioSession('play-and-record');
  // Extension side panel: Chrome won't prompt here. Ask once in a tab, then the note retries.
  if (IS_EXTENSION) {
    const platform = toMediaPlatform('web', true);
    if (needsTabGrant(platform, await mediaPermissionState(kind))) {
      openPermissionTab([kind], { once: true });
      throw new DOMException(`${kind} access needs a tab`, 'NotAllowedError');
    }
    return;
  }
  if (Capacitor.getPlatform() !== 'ios') return;
  let granted = true;
  try {
    ({ granted } = await YoursNative.mediaAccess({ kind }));
  } catch {
    // An older native build without mediaAccess: let getUserMedia ask instead of failing the call.
  }
  if (!granted) throw new DOMException(`${kind} access refused`, 'NotAllowedError');
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

/** WebKit's navigator.audioSession (iOS 16.4+). No-op where unsupported. */
export function setAudioSession(type: 'auto' | 'ambient' | 'playback' | 'play-and-record'): void {
  try {
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = type;
  } catch {
    // not supported
  }
}

export function audioSessionType(): string | undefined {
  try {
    return (navigator as AudioSessionNav).audioSession?.type;
  } catch {
    return undefined;
  }
}
