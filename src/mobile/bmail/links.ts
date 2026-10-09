/**
 * Links in bMail (owner, 9 Oct 2026): from a sender you have not trusted, a link is shown as plain text and is
 * not clickable until you tap "Trust sender". From a trusted sender, http(s) links open in a new tab; anything
 * else (javascript:, data:, custom schemes) is never clickable.
 */
import { noteSegments } from '../airdrops/note';

export type MailSegment = { text: string; link: boolean; href?: string };

/** A safe https/http href for a link-looking segment, or undefined. Bare domains and www. get https://. */
export const safeHref = (raw: string): string | undefined => {
  const t = raw.replace(/[).,;:!?'"\]]+$/, '');
  const withScheme = /^https?:\/\//i.test(t) ? t : /^[a-z]+:/i.test(t) ? '' : `https://${t}`;
  if (!withScheme) return undefined;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** Split mail text into segments; links get an href only when the sender is trusted. */
export const mailSegments = (text: string, trusted: boolean): MailSegment[] =>
  noteSegments(text).map((s) => {
    if (!s.link || !trusted) return s;
    const href = safeHref(s.text);
    return href ? { ...s, href } : s;
  });
