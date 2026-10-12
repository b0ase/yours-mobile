/**
 * Seeing an airdropped NFT (owner, 12 Oct 2026: "no way to SEE them"). The viewer uses only <img>, <video> and
 * <audio>, plus plain text as React text: inscription HTML, SVG or other markup is never rendered and links in it
 * are never followed. Pure helpers; the viewer is in AirdropsInbox.tsx.
 */
import { contentUrls } from '../market/indexer';
import { thumbUrl } from '../market/thumbs';
import type { AirdropItem } from './inbox';

export type ViewKind = 'image' | 'video' | 'audio' | 'text' | 'other';

/** What the viewer may show for a content type. SVG and HTML are markup: 'other' (never rendered). */
export const viewKind = (contentType: string | null | undefined): ViewKind => {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return 'other';
  if (t === 'image/svg+xml') return 'other';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'text/plain' || t === 'text/markdown' || t === 'text/x-markdown' || t === 'application/json') return 'text';
  return 'other';
};

/** Short label for the type icon ("Video", "Audio"…). */
export const kindLabel = (k: ViewKind): string =>
  ({ image: 'Image', video: 'Video', audio: 'Audio', text: 'Text', other: 'File' })[k];

/** The outpoint to read content from: where the NFT sits now, else where it came from (same inscription). */
export const contentOutpoint = (item: Pick<AirdropItem, 'outpoint' | 'asset'>) => item.outpoint || item.asset.id;

/** Full-content URL (first host) and the resized thumbnail for an airdropped NFT. */
export const nftUrls = (item: Pick<AirdropItem, 'outpoint' | 'asset'>) => {
  const op = contentOutpoint(item);
  return { content: contentUrls(op)[0] ?? null, thumb: thumbUrl(op) };
};

/** Text shown at most (a text inscription can be large). */
export const TEXT_MAX = 20_000;
export const clipText = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s);
