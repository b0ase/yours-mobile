import { Capacitor } from '@capacitor/core';
import { YoursNative } from '../native';
import type { MediaKind } from './mediaPermission';

/**
 * iOS: ask AVFoundation for the device first, so the system prompt appears (and the switch exists
 * in Settings) rather than WebKit refusing silently. Throws NotAllowedError when refused, which the
 * screens turn into the Open Settings note. Android/web: getUserMedia itself prompts.
 */
export async function ensureMediaAccess(kind: MediaKind): Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return;
  const { granted } = await YoursNative.mediaAccess({ kind });
  if (!granted) throw new DOMException(`${kind} access refused`, 'NotAllowedError');
}
