import { firstVideoLink } from '../feed/video-embed';
import type { ChatMessage } from './messages';

/** Pure helpers for chat/RoomMedia.tsx (kept apart so that file only exports components). */
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;
export const messageVideo = (body: string | null | undefined) => firstVideoLink(body?.match(URL_RE) ?? []);

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

type MediaPayload = { media_id?: string; mime?: string; filename?: string; byte_size?: number };
export const mediaPayload = (m: ChatMessage): MediaPayload | null => {
  if (m.kind !== 'media') return null;
  const p = (m.event_payload ?? {}) as MediaPayload;
  return typeof p.media_id === 'string' ? p : null;
};
