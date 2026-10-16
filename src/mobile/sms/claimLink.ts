/**
 * Pay by text, recipient side: web.bwalletx.com/claim/t/<code>#k=<claimKey>&t=<fundingTxid>.
 *
 * The one-time key lives ONLY in the URL fragment, which browsers never send to a server. On load we
 * read it into memory, then scrub it from the address bar and history (replaceState) at once. It is
 * also kept in this tab's sessionStorage, because creating a wallet ends with a page reload; that
 * copy is never sent anywhere and is removed as soon as the claim finishes or the drop is closed.
 * Nothing here logs the key, and no request built here carries it (see claimLink.test.ts).
 */
import { PrivateKey } from '@bsv/sdk';
import type { Caller } from './phoneApi';
import { DROPS } from './phoneApi';

export interface ClaimLink {
  code: string;
  wif: string;
  txid: string | null;
}

/** The public status bit-sign PR #304 returns (GET /api/public/sms-drops/<code>): no phone data, no key. */
export interface PublicDrop {
  funded_address: string;
  amount_sats: number;
  status: 'sent' | 'claimed' | 'reclaimed' | 'failed';
  expires_at: string;
  sender_paymail: string;
}

const CODE = /^[A-Za-z0-9_-]{8,64}$/;
const TXID = /^[0-9a-f]{64}$/i;
const PATH = /^\/claim\/t\/([^/]+)\/?$/;
export const CLAIM_SESSION_KEY = 'bw:sms-claim';
/** A kept link older than this is dropped (the visitor walked away mid-onboarding). */
export const CLAIM_SESSION_TTL_MS = 60 * 60 * 1000;

export const publicDropPath = (code: string) => `/api/public/sms-drops/${encodeURIComponent(code)}`;
export const claimedPath = (code: string) => `${DROPS}/${encodeURIComponent(code)}/claimed`;

/** `/claim/t/<code>` + `#k=<WIF>&t=<txid>` → the link; null for anything else or a bad key. */
export function parseClaimLocation(pathname: string, hash: string): ClaimLink | null {
  const m = pathname.match(PATH);
  if (!m) return null;
  let code = '';
  try {
    code = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!CODE.test(code)) return null;
  const frag = new URLSearchParams(hash.replace(/^#/, ''));
  const wif = frag.get('k') || '';
  const txid = frag.get('t') || '';
  try {
    PrivateKey.fromWif(wif);
  } catch {
    return null;
  }
  return { code, wif, txid: TXID.test(txid) ? txid.toLowerCase() : null };
}

interface Loc {
  location: { pathname: string; hash: string; search: string };
  history: { replaceState: (data: unknown, unused: string, url?: string) => void };
}
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let pending: ClaimLink | null = null;
const safeStore = (): Store | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Run once at start-up. A claim link in the address bar is read into memory and the fragment is
 * scrubbed (the path stays, so a refresh shows the same page). Without one, a link kept in this tab
 * before an onboarding reload is restored. Returns the pending link, if any.
 */
export function captureClaim(win: Loc, store: Store | null = safeStore(), now = Date.now()): ClaimLink | null {
  const fromUrl = parseClaimLocation(win.location.pathname, win.location.hash);
  if (win.location.pathname.startsWith('/claim/t/') && win.location.hash) {
    // scrub whatever the fragment held, valid or not, before anything else can read or report it
    win.history.replaceState(null, '', win.location.pathname + win.location.search);
  }
  if (fromUrl) {
    pending = fromUrl;
    try {
      store?.setItem(CLAIM_SESSION_KEY, JSON.stringify({ ...fromUrl, at: now }));
    } catch {
      /* private mode: memory only */
    }
    return pending;
  }
  try {
    const raw = store?.getItem(CLAIM_SESSION_KEY);
    if (raw) {
      const v = JSON.parse(raw) as ClaimLink & { at?: number };
      const fresh = typeof v.at === 'number' && now - v.at < CLAIM_SESSION_TTL_MS;
      const ok = fresh && typeof v.code === 'string' && CODE.test(v.code) && typeof v.wif === 'string';
      if (ok) {
        PrivateKey.fromWif(v.wif);
        pending = { code: v.code, wif: v.wif, txid: v.txid && TXID.test(v.txid) ? v.txid : null };
      } else store?.removeItem(CLAIM_SESSION_KEY);
    }
  } catch {
    store?.removeItem(CLAIM_SESSION_KEY);
  }
  return pending;
}

export const pendingClaim = () => pending;

/** Forget the key everywhere on this device (claimed, closed, or no longer claimable). */
export function clearClaim(store: Store | null = safeStore()) {
  pending = null;
  try {
    store?.removeItem(CLAIM_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function parsePublicDrop(v: unknown): PublicDrop | null {
  const d = (v as { drop?: Record<string, unknown> | null })?.drop;
  if (!d) return null;
  const status = d.status;
  if (status !== 'sent' && status !== 'claimed' && status !== 'reclaimed' && status !== 'failed') return null;
  if (typeof d.amount_sats !== 'number' || typeof d.expires_at !== 'string') return null;
  return {
    funded_address: typeof d.funded_address === 'string' ? d.funded_address : '',
    amount_sats: d.amount_sats,
    status,
    expires_at: d.expires_at,
    sender_paymail: typeof d.sender_paymail === 'string' ? d.sender_paymail : '',
  };
}

/** Public lookup + the "claimed" report. Neither call takes or sends the key. */
export class ClaimApi {
  constructor(private readonly call: Caller) {}
  async lookup(code: string): Promise<PublicDrop | null> {
    return parsePublicDrop(await this.call('GET', publicDropPath(code), undefined, false));
  }
  claimed(code: string, sweepTxid: string) {
    return this.call('POST', claimedPath(code), { sweep_txid: sweepTxid }, false);
  }
}

// ── the claim screen's state machine ──

export type Lookup =
  | { kind: 'loading' }
  | { kind: 'ok'; drop: PublicDrop }
  | { kind: 'not_found' }
  | { kind: 'network'; message?: string };

export type Phase = 'idle' | 'claiming' | 'done' | { error: string };

export type ClaimView =
  | 'loading'
  | 'not_found'
  | 'network'
  | 'already_claimed'
  | 'reclaimed'
  | 'expired'
  | 'need_wallet'
  | 'need_unlock'
  | 'ready'
  | 'claiming'
  | 'done'
  | 'failed';

/** One pure decision for the whole screen, so every state is testable. */
export function claimView(s: {
  lookup: Lookup;
  phase: Phase;
  hasWallet: boolean;
  unlocked: boolean;
  now?: number;
}): ClaimView {
  if (s.phase === 'done') return 'done';
  if (s.lookup.kind === 'loading') return 'loading';
  if (s.lookup.kind === 'not_found') return 'not_found';
  if (s.lookup.kind === 'network') return 'network';
  const d = s.lookup.drop;
  if (d.status === 'claimed') return 'already_claimed';
  if (d.status === 'reclaimed' || d.status === 'failed') return 'reclaimed';
  const exp = Date.parse(d.expires_at);
  if (Number.isFinite(exp) && exp <= (s.now ?? Date.now())) return 'expired';
  if (s.phase === 'claiming') return 'claiming';
  if (typeof s.phase === 'object') return 'failed';
  if (!s.hasWallet) return 'need_wallet';
  if (!s.unlocked) return 'need_unlock';
  return 'ready';
}

/** The view says the link is finished with: forget the key. */
export const isTerminal = (v: ClaimView) =>
  v === 'done' || v === 'already_claimed' || v === 'reclaimed' || v === 'expired' || v === 'not_found';

export const senderName = (paymail: string) => {
  const h = paymail.split('@')[0];
  return h ? `$${h}` : 'Someone';
};
