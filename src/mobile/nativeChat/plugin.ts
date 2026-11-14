import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** One event channel from the native chat. Everything that needs keys, money or the network is answered in JS. */
export type NativeChatAction =
  | { type: 'open'; ticker: string }
  | { type: 'close'; ticker: string }
  | { type: 'send'; ticker: string; text: string }
  | { type: 'retry'; ticker: string; localId: string }
  | { type: 'older'; ticker: string }
  | { type: 'classicRoom'; ticker: string }
  | { type: 'classicList' }
  | { type: 'swipe'; ticker: string; action: 'read' | 'unread' | 'pin' | 'unpin' | 'mute' | 'unmute' | 'archive' };

export type NativeComposer = { kind: 'open' } | { kind: 'readonly'; note: string } | { kind: 'classic'; note: string };

export interface NativeChatPlugin {
  /** Rect in CSS px (= points) of the list between the web bars. */
  show(opts: { top: number; left: number; width: number; height: number; me: string; accent?: string }): Promise<void>;
  hide(): Promise<void>;
  setRooms(opts: { roomsJson: string }): Promise<void>;
  /** `from` > 0: rows before it are unchanged (see rows.ts diffRows). */
  setRoom(opts: {
    ticker: string;
    from: number;
    rowsJson: string;
    hasMore: boolean;
    cacheable: boolean;
    loading: boolean;
    error: string;
    composerJson: string;
  }): Promise<void>;
  popToList(): Promise<void>;
  /** Sign-out: the native disk cache and memory go. */
  clearCache(): Promise<void>;
  addListener(event: 'action', fn: (a: NativeChatAction) => void): Promise<PluginListenerHandle>;
}

export const NativeChat = registerPlugin<NativeChatPlugin>('NativeChat');
