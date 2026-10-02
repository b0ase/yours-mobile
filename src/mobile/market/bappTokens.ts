/**
 * Market › Tokens › bApps: the BSV-21 tokens of bCorp's bApps ($bMail, $bDrive…), shown as ordinary
 * tokens with the same list, floor and trading as every other token. No share offers, no investor
 * checks (the old share-offer panel, SharesPanel.tsx, is no longer shown).
 *
 * Listed by token id (`<txid>_<vout>`), since tickers aren't unique. Add each bApp token here once
 * it is minted.
 */
export const BAPP_TOKENS: readonly { app: string; ticker: string; tokenId: string }[] = [];

const IDS = new Set(BAPP_TOKENS.map((t) => t.tokenId));
export const isBappToken = (tokenId: string, ids: ReadonlySet<string> = IDS) => ids.has(tokenId);
