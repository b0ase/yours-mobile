import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { BMUSIC_URL, StreamHttpError } from './api';

/**
 * The artist's listener board (bitcoin-music /api/bmusic/leaderboard). Opt-in: a listener links a session key
 * to their identity with a wallet signature; opting out is signed the same way. Default off; the choice is
 * remembered per artist on this device.
 */
export const CLAIM_PROTOCOL: WalletProtocol = [2, 'bmusic listen claim'];
export type BoardWindow = 'all' | '30d' | '7d';
export type BoardListener = {
  rank: number;
  identityKey: string;
  handle?: string | null;
  fanScore: number;
  secondsTotal: number;
  secondsSelfPaid: number;
  secondsSponsored: number;
  completedTracks: number;
  distinctTracks: number;
  badges: string[];
};
export type Board = { listeners: BoardListener[]; anonCount: number; anonSeconds: number };
export type MyStats = Partial<BoardListener> & { rank?: number | null };

type Fetch = typeof fetch;
const json = async <T>(r: Response): Promise<T> => {
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new StreamHttpError(r.status, body.error ?? r.statusText);
  return body as T;
};

export const claimMessage = (sessionPubKey: string, ts: number) => `claim:${sessionPubKey}:${ts}`;
export const optOutMessage = (identityKey: string, ts: number) => `optout:${identityKey}:${ts}`;

/** createSignature args for a claim / opt-out (exported for tests). */
export const claimSigArgs = (sessionPubKey: string, ts: number) => ({
  protocolID: CLAIM_PROTOCOL,
  keyID: sessionPubKey,
  counterparty: 'anyone' as const,
  data: Utils.toArray(claimMessage(sessionPubKey, ts), 'utf8'),
});
export const optOutSigArgs = (identityKey: string, ts: number) => ({
  protocolID: CLAIM_PROTOCOL,
  keyID: 'optout',
  counterparty: 'anyone' as const,
  data: Utils.toArray(optOutMessage(identityKey, ts), 'utf8'),
});

type Signer = Pick<WalletInterface, 'createSignature' | 'getPublicKey'>;
const sign = async (w: Signer, args: ReturnType<typeof claimSigArgs>) =>
  Utils.toHex((await w.createSignature(args)).signature);

/** Claim this session's seconds for the wallet's identity. 409 = claimed by another identity. */
export async function claimSession(
  w: Signer,
  sessionPubKey: string,
  handle?: string,
  opts: { f?: Fetch; base?: string; now?: () => number } = {},
) {
  const ts = (opts.now ?? Date.now)();
  const identityKey = (await w.getPublicKey({ identityKey: true })).publicKey;
  const sig = await sign(w, claimSigArgs(sessionPubKey, ts));
  const body = { sessionPubKey, identityKey, ...(handle ? { handle } : {}), ts, sig };
  return (opts.f ?? fetch)(`${opts.base ?? BMUSIC_URL}/api/bmusic/listen/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<unknown>(r));
}

export async function optOut(w: Signer, opts: { f?: Fetch; base?: string; now?: () => number } = {}) {
  const ts = (opts.now ?? Date.now)();
  const identityKey = (await w.getPublicKey({ identityKey: true })).publicKey;
  const sig = await sign(w, optOutSigArgs(identityKey, ts));
  return (opts.f ?? fetch)(`${opts.base ?? BMUSIC_URL}/api/bmusic/listen/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityKey, ts, sig, optOut: true }),
  }).then((r) => json<unknown>(r));
}

export const getBoard = (albumId: string, window: BoardWindow, f: Fetch = fetch, base = BMUSIC_URL) =>
  f(`${base}/api/bmusic/leaderboard?albumId=${encodeURIComponent(albumId)}&window=${window}`).then((r) =>
    json<Board>(r),
  );
export const getMyStats = (identityKey: string, albumId: string, f: Fetch = fetch, base = BMUSIC_URL) =>
  f(`${base}/api/bmusic/listener/${encodeURIComponent(identityKey)}?albumId=${encodeURIComponent(albumId)}`).then((r) =>
    json<MyStats>(r),
  );

// ── per-artist choice (localStorage) ─────────────────────────────────────────
const prefKey = (artist: string) => `bwx.bmusic.board.${artist.toLowerCase()}`;
export const boardChoice = (artist: string): 'yes' | 'no' | null => {
  try {
    const v = localStorage.getItem(prefKey(artist));
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
};
export const setBoardChoice = (artist: string, v: 'yes' | 'no') => {
  try {
    localStorage.setItem(prefKey(artist), v);
  } catch {
    /* not remembered: asked again next session */
  }
};

// ── display ──────────────────────────────────────────────────────────────────
const BADGE_LABELS: Record<string, string> = {
  top: 'Top listener',
  'top-listener': 'Top listener',
  superfan: 'Superfan',
  first100: 'First 100',
  'first-100': 'First 100',
  completed: 'Completed the album',
  'completed-album': 'Completed the album',
};
/** Known badges by label; unknown ones pass through as the server named them. */
export const badgeLabel = (b: string) => BADGE_LABELS[b.toLowerCase()] ?? b;
export const shortKey = (k: string) => (k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);
export const displayName = (l: Pick<BoardListener, 'handle' | 'identityKey'>) =>
  l.handle?.trim() || shortKey(l.identityKey);
export const listened = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
};
/** The "You:" line. */
export const myLine = (me: MyStats | null) =>
  me && typeof me.rank === 'number' && me.rank > 0
    ? `You: #${me.rank}${me.badges?.length ? ` · ${me.badges.map(badgeLabel).join(' · ')}` : ''}`
    : 'Not on the board';

export type BoardState = 'loading' | 'error' | 'empty' | 'list';
export const boardState = (board: Board | null, error: string | null): BoardState =>
  error && !board ? 'error' : !board ? 'loading' : board.listeners.length ? 'list' : 'empty';
