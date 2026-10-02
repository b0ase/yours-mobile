/**
 * Market › Tokens › bApps: the BSV-21 tokens of bCorp's bApps ($bMail, $bDrive…), shown as ordinary
 * tokens with the same list, floor and trading as every other token. No share offers, no investor
 * checks (the old share-offer panel, SharesPanel.tsx, is no longer shown).
 *
 * bApps without a token yet are listed too, labelled "Not launched": name, icon and what the app
 * does, with no price, listing or buy (unlaunchedBapps).
 *
 * Listed by token id (`<txid>_<vout>`), since tickers aren't unique. Add each bApp token here once
 * it is minted.
 */
export const BAPP_TOKENS: readonly { app: string; ticker: string; tokenId: string }[] = [];

const IDS = new Set(BAPP_TOKENS.map((t) => t.tokenId));
export const isBappToken = (tokenId: string, ids: ReadonlySet<string> = IDS) => ids.has(tokenId);

/** bApps with no token yet, in the bApps store's order. */
export const unlaunchedBapps = <A extends { name: string }>(apps: readonly A[], tokens = BAPP_TOKENS): A[] => {
  const launched = new Set(tokens.map((t) => t.app.toLowerCase()));
  return apps.filter((a) => !launched.has(a.name.toLowerCase()));
};
