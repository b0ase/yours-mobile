/**
 * User-generated content safety (Apple 1.2, Google Play UGC policy):
 *
 *  - Terms of use with a zero-tolerance clause, agreed once before first use of Feed, Chat, DMs
 *    or Calls (stored on this device; the text is hosted at bitcoinchat.online/terms#conduct).
 *  - Reports go to bit-sign POST /api/bitsign/report (content_reports), which the owner must act
 *    on within 24 hours.
 *  - Blocked bChat handles: hidden locally (DMs, messages, calls) and sent to bit-sign
 *    /api/bitsign/me/blocks, which stops DMs both ways.
 */
import { BCHAT_ORIGIN, type Http } from '../chat/api';

export const SUPPORT_EMAIL = 'info@bitcoincorporation.website';
export const TERMS_URL = `${BCHAT_ORIGIN}/terms#conduct`;
export const DELETE_ACCOUNT_URL = `${BCHAT_ORIGIN}/delete-account`;
export const REPORT_URL = `${BCHAT_ORIGIN}/api/bitsign/report`;

/** Bump when the terms change materially: everyone is asked to agree again. */
export const TERMS_VERSION = '2026-10-02';
const TERMS_KEY = 'bwallet.terms.accepted';
const BLOCKS_KEY = 'bwallet.chat.blocked';

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

const listeners = new Set<() => void>();
export const onUgcChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

// ── Terms ──

export const termsAccepted = () => ls.get(TERMS_KEY) === TERMS_VERSION;
export const acceptTerms = () => {
  ls.set(TERMS_KEY, TERMS_VERSION);
  emit();
};

/** The in-app summary of the terms (full text: TERMS_URL). */
export const TERMS_POINTS = [
  'No objectionable content: nothing illegal, sexually explicit, hateful, violent, threatening, harassing, exploitative of children, self-harm promoting, spam or scams.',
  'No abusive users. There is zero tolerance: we remove offending content and ban offending accounts.',
  'Report content or users with Report, and block anyone with Block. We review every report within 24 hours.',
  'Posts and payments written to the blockchain are public and permanent. We can remove them from our apps but not from the chain.',
  `Contact: ${SUPPORT_EMAIL}`,
];

// ── Reports ──

export type ReportKind = 'feed_post' | 'market_item' | 'dm_message' | 'room_message' | 'room' | 'user' | 'ai_response' | 'bapp';
export const REPORT_REASONS: { id: string; label: string }[] = [
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'hate', label: 'Hate or discrimination' },
  { id: 'sexual', label: 'Sexual or adult content' },
  { id: 'violence', label: 'Violence or threats' },
  { id: 'scam', label: 'Scam or spam' },
  { id: 'self_harm', label: 'Self-harm' },
  { id: 'other', label: 'Something else' },
];

export interface Report {
  kind: ReportKind;
  /** What is reported: a $handle, message id, txid… */
  target: string;
  reason: string;
  details?: string;
  /** A copy of the reported text, so the reviewer sees what the user saw. */
  content?: string;
}

export const reportBody = (r: Report) => ({
  kind: r.kind,
  target: r.target.slice(0, 512),
  reason: r.reason,
  details: r.details?.slice(0, 2000) || undefined,
  content: r.content?.slice(0, 8000) || undefined,
  source: 'bwallet',
});

/** Sends a report. Throws a user-readable error when it did not reach the server. */
export const sendReport = async (http: Http, r: Report, url = REPORT_URL): Promise<void> => {
  let status = 0;
  let data: unknown = null;
  try {
    ({ status, data } = await http({ method: 'POST', url, headers: { Accept: 'application/json' }, body: reportBody(r) }));
  } catch {
    throw new Error(`Couldn't send the report. Check your connection, or email ${SUPPORT_EMAIL}.`);
  }
  if (status < 200 || status >= 300) {
    const msg = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof msg === 'string' && msg ? msg : `Couldn't send the report (${status}).`);
  }
};

// ── Blocks (bChat handles) ──

export const normHandle = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();

export const blockedHandles = (): string[] => {
  try {
    const v = JSON.parse(ls.get(BLOCKS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
export const isBlocked = (handle: string | null | undefined) =>
  !!handle && blockedHandles().includes(normHandle(handle));

const saveBlocks = (list: string[]) => {
  ls.set(BLOCKS_KEY, list.length ? JSON.stringify([...new Set(list)]) : null);
  emit();
};
export const blockLocal = (handle: string) => saveBlocks([...blockedHandles(), normHandle(handle)]);
export const unblockLocal = (handle: string) => saveBlocks(blockedHandles().filter((h) => h !== normHandle(handle)));
/** Merge the server's list in (blocks made on another device). */
export const mergeBlocks = (server: string[]) => saveBlocks([...blockedHandles(), ...server.map(normHandle)]);

/** Local data this module keeps, for account deletion. */
export const clearUgcLocal = () => {
  ls.set(BLOCKS_KEY, null);
  emit();
};
