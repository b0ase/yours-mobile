/* ── Card art from a video NFT (owner, 12 Oct 2026) ──────────────────────────────────────────────────────────
   The wallet may hold only video NFTs (VexVoid clips), so "My NFTs" in the card designer lists them too. Picking
   one opens a frame picker; "Use this frame" draws the current frame to a canvas and the JPEG goes on the card
   exactly like a picture NFT (My pictures, this device only).

   CORS: the content hosts send `Access-Control-Allow-Origin: *`, but none of them answer byte-range requests
   (videoCover.ts), which iOS needs to seek a streamed video. So the picker always downloads the bytes first and
   plays a blob: URL: same-origin, so the canvas is never tainted and seeking works everywhere. Pending NFTs play
   from the wallet's own signed transaction (nftViewer.localInscription). */
import type { MediaItem } from '../media/useWalletMedia';
import { CARD_IMG_MAX, fitWithin, isCardNftType } from './cardFrontArt';

/** Video NFTs a browser can decode to a frame. */
export function isCardVideoType(contentType: string | null | undefined): boolean {
  const t = (contentType ?? '').toLowerCase().split(';')[0].trim();
  return t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime' || t === 'video/ogg';
}

/** What My NFTs offers: raster pictures (on chain) and video clips (on chain or pending); never flagged ones. */
export function cardNftChoices(items: MediaItem[]): MediaItem[] {
  return items.filter(
    (i) => !i.flagged && ((isCardNftType(i.type) && !i.pending) || (i.kind === 'video' && isCardVideoType(i.type))),
  );
}

type FrameSource = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'> & CanvasImageSource;

/** The video's current frame as a resized JPEG data URI (black behind it), or a plain-English error. */
export function captureVideoFrame(
  video: FrameSource,
  max = CARD_IMG_MAX,
  quality = 0.84,
  doc: Pick<Document, 'createElement'> = document,
): string {
  const { w, h } = fitWithin(video.videoWidth, video.videoHeight, max);
  if (!w) throw new Error('The video hasn’t shown a frame yet. Try again in a moment.');
  const c = doc.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('This device can’t make pictures from video.');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(video, 0, 0, w, h);
  try {
    return c.toDataURL('image/jpeg', quality);
  } catch {
    // A tainted canvas (cross-origin video without CORS) throws SecurityError here.
    throw new Error('That video can’t be copied into a picture.');
  }
}
