/** The sender's own copy of a sent letter (SentReader.tsx): what to show, and what went with it. */
import type { Sent } from './store';

export const NO_SENT_COPY = 'This letter was sent before sent copies were kept, so its text is not on this device.';

const has = (v: unknown) => v !== undefined && v !== null;

/** Names of what went with the letter (attachments), for the read-only view. */
export const sentAttachments = (s: Sent): string[] => [
  ...(has(s.agreement) ? ['Bureau agreement'] : []),
  ...(has(s.offer) ? ['Company offer'] : []),
  ...(s.ordinal ? [`NFT${s.ordinal.name ? `: ${s.ordinal.name}` : ''}`] : []),
  ...(has(s.note) ? ['Signed note'] : []),
];

/** The body to show, or null when no copy of the text was kept. */
export const sentBody = (s: Pick<Sent, 'body'>): string | null =>
  typeof s.body === 'string' && s.body.trim() ? s.body : null;
