/**
 * Penny Notes ($PNEE): a dollar stablecoin on BSV backed only by BSV locked in public vaults (docs/PENNY-NOTES.md).
 * A BSV-21 token with 2 decimals: 1 unit = 1¢, shown as dollars. Empty until the token is deployed (mainnet pilot).
 */
export const PNEE_TOKEN_ID = '';
export const PNEE_DECIMALS = 2;

/** A cheeky nod to MNEE's coin (navy disc, open gold ring) with a cent sign. Inline: no network fetch. */
export const PNEE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 228 228"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC93C"/><stop offset="1" stop-color="#F29A1F"/></linearGradient></defs><circle cx="114" cy="114" r="114" fill="#05121F"/><path d="M14 102 A100 100 0 0 1 214 102" fill="none" stroke="url(#g)" stroke-width="14" stroke-linecap="round"/><path d="M214 126 A100 100 0 0 1 14 126" fill="none" stroke="url(#g)" stroke-width="14" stroke-linecap="round"/><text x="114" y="158" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="800" font-size="128" fill="url(#g)">¢</text></svg>',
);
