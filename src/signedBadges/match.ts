/**
 * Text normalisation and badge matching for signed posts. Pure: the content script feeds it what it read from the
 * page, the background the proofs it verified.
 *
 * AuthSig signs a post on X as the post's `textContent` (line breaks between paragraphs vanish, emoji drawn as
 * images vanish) and compares page text after collapsing whitespace (`s.replace(/\s+/g, ' ').trim()`). We do the
 * same, and also accept the text with image alt text kept and a whitespace-free comparison, so a proof written
 * from the compose box (with line breaks) still matches the post as X shows it.
 */
import { isContentHashKey, xPostIdFromKey, type VerifiedProof } from './record';

/** AuthSig's normalisation: runs of whitespace become one space, ends trimmed. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim();

const squash = (s: string): string => s.replace(/\s+/g, '');
const TRAILING_ELLIPSIS = /(?:…|\.\.\.)\s*$/;

/**
 * Does the signed text match what the page shows? `truncated`: the page shows only the start of the post ("Show
 * more"), so the shown text must be a prefix of at least 20 characters.
 */
export const textMatches = (signed: string, shown: string, opts: { truncated?: boolean } = {}): boolean => {
  const a = normalizeText(signed);
  const b = normalizeText(shown);
  if (!a || !b) return false;
  if (a === b || squash(a) === squash(b)) return true;
  if (!opts.truncated) return false;
  const head = normalizeText(b.replace(TRAILING_ELLIPSIS, ''));
  return head.length >= 20 && (a.startsWith(head) || squash(a).startsWith(squash(head)));
};

/**
 * The strings whose sha256 may be a post's content-hash key: as read, trimmed (AuthSig hashes trimmed text nodes)
 * and normalised. Duplicates and empty strings dropped.
 */
export const hashCandidates = (texts: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const t of texts) {
    for (const c of [t, t.trim(), normalizeText(t)]) if (c) out.add(c);
  }
  return [...out];
};

/** A post (or comment, or description) found on the page, as the matcher needs it. */
export type PostRef = {
  /** Local id for the caller's map. */
  id: string;
  /** `x-post-<id>` for a post on X. */
  xKey?: string;
  /** Text variants read from the post (textContent, with image alts, ...). */
  texts: readonly string[];
  /** Content-hash keys the post's text produced, each with the exact text that hashed to it. */
  hashes: readonly { key: string; text: string }[];
  truncated?: boolean;
};

/**
 * Proofs that belong to each post: an x-post proof whose signed text matches the post, and any content-hash proof
 * for the post's own text. One entry per signer (their earliest), oldest first.
 */
export const matchProofs = (
  posts: readonly PostRef[],
  proofs: Readonly<Record<string, readonly VerifiedProof[]>>,
): Map<string, VerifiedProof[]> => {
  const out = new Map<string, VerifiedProof[]>();
  for (const post of posts) {
    const found: VerifiedProof[] = [];
    if (post.xKey && xPostIdFromKey(post.xKey)) {
      for (const p of proofs[post.xKey] ?? []) {
        if (post.texts.some((t) => textMatches(p.content, t, { truncated: post.truncated }))) found.push(p);
      }
    }
    for (const h of post.hashes) {
      if (!isContentHashKey(h.key)) continue;
      for (const p of proofs[h.key] ?? []) if (textMatches(p.content, h.text)) found.push(p);
    }
    const bySigner = new Map<string, VerifiedProof>();
    for (const p of found) {
      const prev = bySigner.get(p.publicKey);
      if (!prev || Date.parse(p.signedAt) < Date.parse(prev.signedAt)) bySigner.set(p.publicKey, p);
    }
    const list = [...bySigner.values()].sort((x, y) => Date.parse(x.signedAt) - Date.parse(y.signedAt));
    if (list.length) out.set(post.id, list);
  }
  return out;
};

/** Badge words: "signed by $alice", "signed by $alice +2", or "signed" when no name checked out. */
export const badgeLabel = (proofs: readonly Pick<VerifiedProof, 'name' | 'publicKey'>[], me?: string): string => {
  if (!proofs.length) return '';
  const mine = me ? proofs.find((p) => p.publicKey === me) : undefined;
  const first = mine ?? proofs.find((p) => p.name) ?? proofs[0];
  const who = first === mine ? 'you' : first.name;
  const more = proofs.length > 1 ? ` +${proofs.length - 1}` : '';
  return who ? `signed by ${who}${more}` : `signed${more}`;
};
