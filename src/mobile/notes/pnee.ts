/**
 * Penny Notes ($PNEE): a dollar stablecoin on BSV backed only by BSV locked in public vaults (docs/PENNY-NOTES.md).
 * A BSV-21 token with 2 decimals: 1 unit = 1¢, shown as dollars. Empty until the token is deployed (mainnet pilot).
 */
export const PNEE_TOKEN_ID = '1599c4e49a28c7791295f50613e1545aa9246dd592ae8b8f696b81916a475ae4_0';
export const PNEE_DECIMALS = 2;

/** A cheeky nod to MNEE's coin (navy disc, open gold ring) with a cent sign. Inline: no network fetch. */
export const PNEE_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 228 228"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFC93C"/><stop offset="1" stop-color="#F29A1F"/></linearGradient></defs><circle cx="114" cy="114" r="114" fill="#05121F"/><circle cx="114" cy="114" r="100" fill="none" stroke="url(#g)" stroke-width="12" stroke-dasharray="560 68" transform="rotate(-62 114 114)"/><path d="M150 82 A42 42 0 1 0 150 146" fill="none" stroke="url(#g)" stroke-width="18" stroke-linecap="round"/><rect x="103" y="54" width="22" height="104" rx="11" fill="url(#g)"/><ellipse cx="114" cy="56" rx="16" ry="13" fill="url(#g)"/><circle cx="100" cy="168" r="15" fill="url(#g)"/><circle cx="128" cy="168" r="15" fill="url(#g)"/></svg>',
);
