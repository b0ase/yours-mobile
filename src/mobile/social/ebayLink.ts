/**
 * eBay on Link your accounts (owner, 27 Oct 2026): reuses bMarketX's eBay app (bmarketx.com), the only eBay app we
 * have. Its client id, secret and RuName stay on bMarketX; the wallet never sees an eBay token.
 *
 * bMarketX's seller flow (/api/ebay/start → /api/ebay/callback) needs a bMarketX session and returns to
 * bmarketx.com/sell, so the wallet uses a wallet-mode twin of it on the same eBay app, with the same shape as
 * bWalletX's own sign-in service (socialLogin.ts):
 *   GET  /api/ebay/wallet/status                               -> { ebay: true } once switched on
 *   POST /api/ebay/wallet/start   { provider:'ebay', verifier_hash, return_to? } -> { authorizeUrl }
 *        (eBay → /api/ebay/callback → https://www.bwallet.space/social#p=ebay&t=<ticket>, or the web wallet origin
 *         named by return_to: web | beta | desktop)
 *   POST /api/ebay/wallet/preview { ticket, secret }           -> { provider:'ebay', id, name, display, alias:null }
 *   POST /api/ebay/wallet/link    { ticket, secret, identityKey, timestamp, signature, fields } -> 200 (public copy)
 * Until /status answers { ebay: true } the row says "Coming soon" and no button pretends to link.
 */
export const BMARKETX_API = 'https://bmarketx.com';

export async function ebayAvailable(f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${BMARKETX_API}/api/ebay/wallet/status`);
    if (!r.ok) return false;
    return ((await r.json()) as { ebay?: boolean }).ebay === true;
  } catch {
    return false;
  }
}
