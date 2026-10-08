import { ChatApiError } from './api';

/**
 * A token room opened right after its token was minted: bit-sign checks the holding through the
 * 1Sat indexer, which has not caught up yet. That is a wait, not an error (owner, 8 Oct 2026):
 * the Chat tab shows "Indexing your token…" and retries until the room opens.
 *
 * What bit-sign actually returns before the indexer has the token (rooms/token-gated POST,
 * resolveOneSatGate): 404 "That is not a BSV-21 token." / "That is not a 1Sat collection.",
 * 502 "…the 1Sat indexer did not answer.", or — token known, balance not yet — a 403 without a
 * structured `token_gated` refusal. The 403 is only treated as indexing for a token this wallet
 * minted itself (anyone else's 403 means they really don't hold enough).
 */
export function isNotYetIndexed(e: unknown, opts: { ownToken?: boolean } = {}): boolean {
  if (!(e instanceof ChatApiError)) return false;
  if (e.status === 404) return true;
  if (e.status === 502 && /indexer/i.test(e.message)) return true;
  if (e.status === 403 && opts.ownToken) {
    const d = e.data as { token_gated?: unknown } | null;
    return !(d && typeof d === 'object' && d.token_gated === true);
  }
  return false;
}

/** Fast retries for the first few minutes, then a slow poll for as long as the screen is open. */
export const INDEXING_FAST_MS = 5_000;
export const INDEXING_FAST_WINDOW_MS = 3 * 60_000;
export const INDEXING_SLOW_MS = 30_000;

/** Delay before the next attempt, given how long we have been waiting. */
export const indexingRetryDelay = (elapsedMs: number): number =>
  elapsedMs < INDEXING_FAST_WINDOW_MS ? INDEXING_FAST_MS : INDEXING_SLOW_MS;

export const indexingMessage = (elapsedMs: number): string =>
  elapsedMs < INDEXING_FAST_WINDOW_MS
    ? 'Indexing your token… your room opens shortly'
    : "Still indexing — this can take a few minutes. We'll keep checking.";

/** Is `key` (bsv21:<id> / coll:<id>) one of the wallet's own minted tokens? */
export const isOwnTokenKey = (key: string, own: readonly { tokenId: string }[]): boolean => {
  const id = key.replace(/^(bsv21|coll):/, '').replace('.', '_');
  return own.some((t) => t.tokenId.replace('.', '_') === id);
};
