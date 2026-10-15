/**
 * Exchange token rows: swipe left (or long-press / "…") for Chat · Buy · Info (owner, 15 Oct 2026).
 *
 * - Chat opens the token's room straight away when this wallet holds some of that token. Holdings are
 *   matched on the token ID (`<txid>_<vout>`), never the ticker: two tokens can share a ticker.
 * - Otherwise Chat shows "Hold some to enter" with a Buy shortcut.
 * - Buy opens the trade screen at its Buy panel; Info opens the token page (TokenIdPanel at the top).
 */
import { normOutpoint, tokenKey } from '../chat/tokenRooms';
import { tradeRoute } from './exchangeData';

export type HeldBalance = { id: string; all: { confirmed: bigint; pending: bigint } };

/** Token IDs this wallet holds a positive amount of (normalised). */
export const heldTokenIds = (balances: readonly HeldBalance[]): Set<string> => {
  const out = new Set<string>();
  for (const b of balances) {
    const id = normOutpoint(b.id);
    if (id && b.all.confirmed + b.all.pending > 0n) out.add(id);
  }
  return out;
};

export type ChatDecision = { kind: 'open'; roomKey: string } | { kind: 'hold-first' } | { kind: 'loading' };

/** What Chat does for a token row. `held` null = holdings still loading (or unreadable). */
export const chatDecision = (tokenId: string, held: ReadonlySet<string> | null): ChatDecision => {
  if (!held) return { kind: 'loading' };
  const id = normOutpoint(tokenId);
  const roomKey = id ? tokenKey('bsv21', id) : null;
  if (id && roomKey && held.has(id)) return { kind: 'open', roomKey };
  return { kind: 'hold-first' };
};

/** Anchor on the trade screen's Buy panel. */
export const BUY_ANCHOR = 'buy';
export const buyRoute = (tokenId: string) => `${tradeRoute(tokenId)}#${BUY_ANCHOR}`;
export const infoRoute = (tokenId: string) => tradeRoute(tokenId);

/** Left-swipe tray order (outermost last): Chat, Buy, Info. */
export const ROW_ACTION_IDS = ['chat', 'buy', 'info'] as const;
