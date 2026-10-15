/**
 * Balance card ⇄ wallet list sync (owner, 15 Oct 2026). Pure helpers: which list a card shows, which card a
 * chip lands on, and which token rows a coin card keeps.
 */
import type { ListCoin, WalletKind } from './walletKind';

export type CardFilter = { kind: WalletKind; coin: ListCoin };

/** PNEE's BSV-21 id (notes/pnee.ts), repeated so this module stays import-free for tests. */
export const PNEE_ROW_ID = '1599c4e49a28c7791295f50613e1545aa9246dd592ae8b8f696b81916a475ae4_0';

/** The list a card filters to. BSV, Tokens, Top up (and anything unknown) show every token. */
export const filterForCard = (cardId: string): CardFilter => {
  switch (cardId) {
    case 'btickets':
      return { kind: 'tickets', coin: null };
    case 'bcredits':
      return { kind: 'credits', coin: null };
    case 'bshares':
      return { kind: 'shares', coin: null };
    case 'mnee':
      return { kind: 'tokens', coin: 'mnee' };
    case 'pnee':
      return { kind: 'tokens', coin: 'pnee' };
    default:
      return { kind: 'tokens', coin: null };
  }
};

const HOME: Partial<Record<WalletKind, string>> = {
  tokens: 'bsv',
  tickets: 'btickets',
  credits: 'bcredits',
  shares: 'bshares',
};

/**
 * The card index the carousel should scroll to for a list view, or null to stay put: the current card already
 * shows that view, the view has no card (NFTs, Friends), or its card is not in this build.
 */
export const cardForView = (view: CardFilter, cardIds: readonly string[], currentId?: string): number | null => {
  if (currentId !== undefined) {
    const cur = filterForCard(currentId);
    if (cur.kind === view.kind && cur.coin === view.coin) return null;
  }
  const home = view.coin ?? HOME[view.kind];
  if (!home) return null;
  const i = cardIds.indexOf(home);
  return i < 0 ? null : i;
};

/** Whether a Tokens-list row ('bsv', 'mnee', 'pnee' or a BSV-21 id) shows under a coin card. */
export const rowMatchesCoin = (rowId: string, coin: ListCoin): boolean => {
  if (coin === null) return true;
  if (coin === 'mnee') return rowId === 'mnee';
  return rowId === 'pnee' || rowId === PNEE_ROW_ID;
};
