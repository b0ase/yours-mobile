/**
 * Saving a feed image from the full-screen viewer. In the app: the file goes to the app's private cache and the OS
 * share sheet opens (Save Image / Save to Files / Photos / Drive), the same Capacitor Filesystem + Share route as the
 * encrypted backup (backup/backupFile.ts). On a touch browser: the Web Share sheet with the file where supported.
 * Elsewhere: a normal download. If the image host blocks reading it (CORS), the image opens in a new tab instead.
 */
import { saveRoute, type SaveRoute } from '../backup/backupFile';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/** A tidy file name: the outpoint/txid when the image is on-chain, else the URL's last path part. */
export const imageFileName = (src: string, mime: string, ref: string | null): string => {
  const ext = EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'jpg';
  let base = ref ?? '';
  if (!base) {
    try {
      const u = new URL(src);
      const last = !/^https?:$/.test(u.protocol) ? '' : (u.pathname.split('/').filter(Boolean).pop() ?? '');
      base = decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch {
      /* data: or bad URL */
    }
  }
  base = base
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `bwallet-${base || 'image'}.${ext}`;
};

const toBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const SHARE_DIR = 'image-share';

const shareNative = async (file: File): Promise<boolean> => {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  await Filesystem.rmdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true }).catch(() => undefined);
  const { uri } = await Filesystem.writeFile({
    path: `${SHARE_DIR}/${file.name}`,
    data: await toBase64(file),
    directory: Directory.Cache,
    recursive: true,
  });
  try {
    await Share.share({ files: [uri], dialogTitle: 'Save image' });
    return true;
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
};

const download = (file: File) => {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export type SaveResult = 'saved' | 'cancelled' | 'opened';

/** Fetches the full image and hands it to the right save route. Call from a tap. */
export const saveImage = async (
  m: { src: string; mime: string; ref: string | null },
  native: boolean,
): Promise<SaveResult> => {
  let blob: Blob;
  try {
    const res = await fetch(m.src, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    // Unreadable cross-origin image: let the browser show it, where long-press / right-click saves it.
    window.open(m.src, '_blank', 'noopener');
    return 'opened';
  }
  const mime = blob.type.startsWith('image/') ? blob.type : m.mime;
  const file = new File([blob], imageFileName(m.src, mime, m.ref), { type: mime });
  const route: SaveRoute = saveRoute(file, native);
  if (route === 'native') return (await shareNative(file)) ? 'saved' : 'cancelled';
  if (route === 'share') {
    try {
      await navigator.share({ files: [file] });
      return 'saved';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
      // The tap expired while the image downloaded: fall through to a plain download.
    }
  }
  download(file);
  return 'saved';
};
