/** bWalletX-only owner app tiles (TokenBlaster). A store build swaps this file for ownerAppsX.store.ts. */
import type { RadarApp } from './radarApps';
import owner_tokenblaster from './brand/apps/tokenblaster.png';

export const TOKENBLASTER_APPS: RadarApp[] = [
  { name: 'TokenBlaster', url: 'https://www.tokenblaster.lol/blast', desc: 'Load your token into the gun and blast it at the chain', group: 'tools', icon: owner_tokenblaster, source: 'owner' },
];
