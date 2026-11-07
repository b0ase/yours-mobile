/**
 * User-generated content safety (Apple 1.2, Google Play UGC policy):
 *
 *  - Terms of use with a zero-tolerance clause, agreed at account setup (owner, 3 Nov 2026): one line above the last
 *    Continue of create / restore, or a one-tap sheet after unlock for a wallet that never agreed (TermsLine,
 *    TermsOnceSheet in UgcSheets.tsx). Stored on this device; the text is hosted at bchatx.com/terms#conduct. Feed,
 *    Chat, DMs and Calls just open: setup / unlock always comes before them.
 *  - Reports go to bit-sign POST /api/bitsign/report (content_reports), which the owner must act
 *    on within 24 hours.
 *  - Blocked bChat handles: hidden locally (DMs, messages, calls) and sent to bit-sign
 *    /api/bitsign/me/blocks, which stops DMs both ways.
 */
import { BCHAT_ORIGIN, type Http } from '../chat/api';

export const SUPPORT_EMAIL = 'support@bwalletx.com';
/** Responsible disclosure and bug bounty (b-Aware): where to send a security finding, and what it pays. */
export const SECURITY_URL = 'https://bwalletx.com/b-Aware';
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

/**
 * The one line shown at setup and in the sheet (full text: TERMS_URL). "Terms of Use" is the link; owner's
 * wording, 3 Nov 2026. The long in-app list (and its "24 hours" promise) is gone.
 */
export const TERMS_LINE = {
  before: 'By continuing you agree to the ',
  link: 'Terms of Use',
  after:
    '. We remove objectionable content and ban abusive accounts. Anything written to the blockchain is public and permanent.',
} as const;

/** Setup screens: the routes that create or restore a wallet (their own last step carries the line). */
const SETUP_PATHS = ['/', '/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore'];
/** Screens with other people's content (Feed, Chat, DMs, Calls, bPics, Spaces). */
const UGC_PREFIXES = ['/m/feed', '/m/chat', '/m/calls', '/m/bpics', '/m/spaces', '/m/calendar'];

export const isSetupPath = (pathname: string) => SETUP_PATHS.includes(pathname.replace(/(.)\/+$/, '$1'));
export const isUgcPath = (pathname: string) => UGC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Show the one-tap terms sheet? Only once the wallet is open (the lock screen comes first), never over the setup
 * screens (their last step has the line), and only until this device has agreed to the current TERMS_VERSION.
 * Without a wallet (a deep link on the web) it still covers any screen with other people's content.
 */
export const termsSheetNeeded = (s: { accepted: boolean; hasWallet: boolean; locked: boolean; pathname: string }) =>
  !s.accepted && !s.locked && !isSetupPath(s.pathname) && (s.hasWallet || isUgcPath(s.pathname));

// ── Reports ──

export type ReportKind =
  | 'feed_post'
  | 'market_item'
  | 'dm_message'
  | 'room_message'
  | 'room'
  | 'user'
  | 'ai_response'
  | 'bapp';
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
    ({ status, data } = await http({
      method: 'POST',
      url,
      headers: { Accept: 'application/json' },
      body: reportBody(r),
    }));
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
