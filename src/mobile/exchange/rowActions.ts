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

/* ── Other Exchange lists (owner, 15 Oct 2026): People, OpNS names, Podcasts, Movies ─────────────── */

/** A masked handle (".gmail" names arrive as "k•••.gmail") cannot be paid or looked up: no Pay/Profile. */
export const isMaskedHandle = (handle: string) => !handle || handle.includes('•');

/** People › a person's profile (Friends page: their card, or "Add friend" when they are not one yet). */
export const profileRoute = (handle: string) => `/m/friends/${encodeURIComponent(handle.replace(/^\$/, ''))}`;
/** What the Send screen resolves: the $handle (it shows who it is before the approval). */
export const payTarget = (handle: string) => `$${handle.replace(/^\$/, '')}`;

/** People rows: Chat (their room), Pay and Profile (unmasked handles only). */
export const peopleActionIds = (handle: string): ('chat' | 'pay' | 'profile')[] =>
  isMaskedHandle(handle) ? ['chat'] : ['chat', 'pay', 'profile'];

/** The on-chain record behind an outpoint (`<txid>_<vout>` / `<txid>.<vout>`); null for junk. */
export const txInfoUrl = (outpoint: string | null | undefined): string | null => {
  const id = normOutpoint(outpoint ?? '');
  return id ? `https://whatsonchain.com/tx/${id.slice(0, 64)}` : null;
};

/** OpNS name rows: Buy (not on your own listing) and Info (the listing on chain). No offers in the app yet. */
export const opnsActionIds = (o: { canBuy: boolean; outpoint: string }): ('buy' | 'info')[] => [
  ...(o.canBuy ? (['buy'] as const) : []),
  ...(txInfoUrl(o.outpoint) ? (['info'] as const) : []),
];

/** Podcast rows: Play (preview or your own copy), Buy (for sale, not yours), Info (the NFT on chain). */
export const podcastActionIds = (p: {
  playable: boolean;
  canBuy: boolean;
  origin: string | null;
}): ('play' | 'buy' | 'info')[] => [
  ...(p.playable ? (['play'] as const) : []),
  ...(p.canBuy ? (['buy'] as const) : []),
  ...(txInfoUrl(p.origin) ? (['info'] as const) : []),
];

/** Movie cards: Back (its token), Own a clip (when clips are for sale), Chat only when you hold the token ID. */
export const movieActionIds = (
  tokenId: string,
  clips: number,
  held: ReadonlySet<string> | null,
): ('back' | 'clip' | 'chat')[] => [
  'back',
  ...(clips > 0 ? (['clip'] as const) : []),
  ...(chatDecision(tokenId, held).kind === 'open' ? (['chat'] as const) : []),
];
