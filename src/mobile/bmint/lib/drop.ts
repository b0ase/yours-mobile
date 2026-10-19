/**
 * bMint's "Drop anything you made" (BmintPage.tsx Studio hero): which existing Mint sheet type a dropped file
 * opens (mint/MintButton.tsx MINT_TILES ids), plus a one-shot handoff of the File to that sheet. Pure helpers,
 * unit-tested in drop.test.ts. The sheet still runs its own checks on the file (type, size, 3D magic bytes).
 */

export type DropTile = 'art' | 'music' | 'video' | '3d' | 'books' | 'website';

/** Every file type the drop zone's picker offers (the Mint sheet's media types plus books, text and HTML). */
export const DROP_ACCEPT =
  'image/*,video/*,audio/*,.glb,.gltf,.usdz,application/pdf,.pdf,application/epub+zip,.epub,text/plain,.txt,text/markdown,.md,text/html,.html,.htm';

/** The Mint sheet type for a file, by browser type then extension; null when nothing mints it. */
export function tileForFile(type: string, name: string): DropTile | null {
  const t = (type || '').toLowerCase().split(';')[0].trim();
  const n = (name || '').toLowerCase();
  if (/\.(glb|gltf|usdz)$/.test(n) || t.startsWith('model/')) return '3d';
  if (t.startsWith('image/')) return 'art';
  if (t.startsWith('audio/')) return 'music';
  if (t.startsWith('video/')) return 'video';
  if (t === 'text/html' || /\.html?$/.test(n)) return 'website';
  if (
    /^(application\/pdf|application\/epub\+zip|text\/plain|text\/markdown)$/.test(t) ||
    /\.(pdf|epub|txt|md)$/.test(n)
  )
    return 'books';
  return null;
}

export const DROP_UNSUPPORTED =
  "That kind of file can't be minted yet. Try a picture, a track, a video, a 3D model, a PDF or ebook, or a web page.";

/** Short label for the preview card. */
export const TILE_LABEL: Record<DropTile, string> = {
  art: 'Art & photos',
  music: 'Music',
  video: 'Video',
  '3d': '3D model',
  books: 'Book or document',
  website: 'One-page site',
};

let dropped: File | null = null;
/** Keep the dropped file for the Mint sheet that opens next. */
export const handOff = (f: File | null) => {
  dropped = f;
};
/** The dropped file, once (the sheet takes it; a later open starts empty). */
export const takeHandOff = (): File | null => {
  const f = dropped;
  dropped = null;
  return f;
};
