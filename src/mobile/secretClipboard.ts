import { isNative, YoursNative } from './native';

/**
 * Copy a secret (recovery phrase, private key, wallet password) without a warning popup (owner, 14 Oct 2026):
 *  - Android: the clip is marked sensitive (ClipDescription.EXTRA_IS_SENSITIVE), so the system preview hides it;
 *  - iOS: a local-only pasteboard item (no Universal Clipboard to other devices) that expires after 60 seconds;
 *  - web / extension: the plain clipboard API.
 * After 60 seconds the clipboard is wiped silently, but only if it still holds this secret: anything the user
 * copied since is left alone. Nothing here logs the secret or sends it anywhere.
 */
export const SECRET_CLIPBOARD_SECONDS = 60;

export type ClipboardPort = {
  /** Writes the secret; resolves a token that later identifies "our" clip (or null if none is needed). */
  write(text: string, seconds: number): Promise<unknown>;
  /** Clears the clipboard if it still holds the secret written with `token`. */
  clearIfStill(text: string, token: unknown): Promise<void>;
};

const nativePort: ClipboardPort = {
  async write(text, seconds) {
    const r = await YoursNative.secretCopy({ text, seconds });
    return r?.token ?? null;
  },
  async clearIfStill(_text, token) {
    await YoursNative.secretClear({ token: typeof token === 'string' ? token : '' });
  },
};

const webPort: ClipboardPort = {
  async write(text) {
    await navigator.clipboard.writeText(text);
    return null;
  },
  async clearIfStill(text) {
    // Reading may be refused (no permission, page not focused): then we can't tell, so we leave it.
    const now = await navigator.clipboard.readText();
    if (now === text) await navigator.clipboard.writeText('');
  },
};

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Testable core: one pending wipe at a time; a newer secret copy replaces the older wipe. */
export const makeSecretClipboard = (port: ClipboardPort, timers: Timers = realTimers) => {
  let pending: unknown = null;
  return async (text: string, seconds = SECRET_CLIPBOARD_SECONDS): Promise<void> => {
    const token = await port.write(text, seconds);
    if (pending !== null) timers.clear(pending);
    pending = timers.set(() => {
      pending = null;
      void port.clearIfStill(text, token).catch(() => undefined);
    }, seconds * 1000);
  };
};

let copier: ((text: string) => Promise<void>) | null = null;

/** Copy a secret: sensitive / local-only where the platform allows, wiped after 60 s if unchanged. */
export const copySecret = (text: string): Promise<void> => {
  copier ??= makeSecretClipboard(isNative ? nativePort : webPort);
  return copier(text);
};
