/**
 * bWalletX Chrome extension: the side panel/popup can't show Chrome's mic/camera prompt, so
 * getUserMedia is refused silently there. A tab of the extension (permissions.html) can ask, and
 * the grant then covers the whole extension origin. The tab posts MEDIA_GRANTED when done.
 */
import type { MediaKind } from './mediaPermission';

export const MEDIA_GRANTED = 'BWALLETX_MEDIA_GRANTED';

type Chromeish = {
  runtime?: {
    getURL?: (p: string) => string;
    onMessage?: {
      addListener: (fn: (m: unknown) => void) => void;
      removeListener: (fn: (m: unknown) => void) => void;
    };
  };
  tabs?: { create?: (o: { url: string }) => unknown };
};
const chromeApi = (): Chromeish | undefined => (globalThis as { chrome?: Chromeish }).chrome;

const opened = new Set<string>();

/** Chrome's current state for the mic/camera, or 'unknown' where it can't say. */
export async function mediaPermissionState(kind: MediaKind): Promise<PermissionState | 'unknown'> {
  try {
    const name = (kind === 'mic' ? 'microphone' : 'camera') as PermissionName;
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'unknown';
  }
}

/** Open the permission tab. `once` = at most one automatic open per kind per session. */
export function openPermissionTab(kinds: MediaKind[], opts: { once?: boolean } = {}): boolean {
  const key = [...kinds].sort().join(',');
  if (opts.once && opened.has(key)) return false;
  const c = chromeApi();
  if (!c?.runtime?.getURL || !c.tabs?.create) return false;
  opened.add(key);
  void c.tabs.create({ url: c.runtime.getURL(`permissions.html?kinds=${encodeURIComponent(key)}`) });
  return true;
}

/** Runs `fn` when the permission tab reports a grant. */
export function onMediaGranted(fn: () => void): () => void {
  const om = chromeApi()?.runtime?.onMessage;
  if (!om) return () => undefined;
  const h = (m: unknown) => {
    if ((m as { action?: unknown } | null)?.action === MEDIA_GRANTED) fn();
  };
  om.addListener(h);
  return () => om.removeListener(h);
}
