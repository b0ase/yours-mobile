/**
 * Apps the owner ships with bWalletX (Apps tab, alongside BSVRadar and Metanet apps). Add one with
 *   pnpm add-app <url> [group]        (group: market social media tools money explore learn games; default tools)
 * which fetches the site's name, tagline and icon (saved as a 96px PNG beside the others) and appends
 * it here. Edit by hand freely; keep the markers.
 */
import type { RadarApp } from './radarApps';
import owner_budz_lol from './brand/apps/radar/owner-budz-lol.png';
import owner_budgirls_pro from './brand/apps/radar/owner-budgirls-pro.png';
import owner_zanaadu_com from './brand/apps/radar/owner-zanaadu-com.png';
// ADD-APP:IMPORTS

export const OWNER_APPS: RadarApp[] = [
  { name: 'BUDZ', url: 'https://budz.lol', desc: 'BUDZ — twelve strains, twelve tokens. Every strain gets a ticker and a room: hold the one ', group: 'social', icon: owner_budz_lol, source: 'owner' },
  { name: 'BUDGIRLS', url: 'https://budgirls.pro', desc: 'BUDGIRLS — cannabis influencers, tokenised. Pick your girl and hold her ticker to get into', group: 'social', icon: owner_budgirls_pro, source: 'owner' },
  { name: 'Zanaadu', url: 'https://zanaadu.com', desc: 'Post, engage, and earn on a social network where every upvote pays creators directly. Stor', group: 'social', icon: owner_zanaadu_com, source: 'owner' },
  // ADD-APP:ENTRIES
];
