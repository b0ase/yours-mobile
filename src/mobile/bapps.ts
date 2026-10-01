import bvideoIcon from './brand/bvideo-icon.png';
import bcalIcon from './brand/bcal-icon.png';
import bsheetsIcon from './brand/bsheets-icon.png';
import bmintIcon from './brand/bmint-icon.png';
import bmusicIcon from './brand/bmusic-icon.png';
/**
 * The bApps store (Apps › bApps): The Bitcoin Corporation's own apps. Edit here.
 * status: 'live' = the site answered 200 with a real page when checked
 * (2026-10-01); 'demo' = not yet live. Demo apps are shown, labelled Demo.
 * icon: the site's favicon/apple-touch icon; omit for the gold "b" monogram.
 */
export type BAppGroup = 'featured' | 'work' | 'media' | 'social';

export type BApp = {
  name: string; // the b-name
  url: string;
  verb: string; // one line: what you do there
  group: BAppGroup;
  status: 'live' | 'demo';
  icon?: string;
  /** GitHub repo URL when open source; omit for closed source. */
  source?: string;
};

const suite = (repo: string) => `https://github.com/bitcoin-apps-suite/${repo}`;

export const BAPP_GROUPS: { id: BAppGroup; label: string }[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'work', label: 'Work' },
  { id: 'media', label: 'Media' },
  { id: 'social', label: 'Social & money' },
];

export const BAPPS: BApp[] = [
  // Featured
  {
    name: 'bChat',
    url: 'https://www.bitcoinchat.online',
    verb: 'Chat, voice and video messages, tokenised group chats',
    group: 'featured',
    status: 'live',
    icon: 'https://www.bitcoinchat.online/bchat-apple-touch-icon.png',
  },
  {
    name: 'bMovies',
    url: 'https://www.bmovies.app',
    verb: 'Watch and back tokenised films',
    group: 'featured',
    status: 'live',
    icon: 'https://www.bmovies.app/icons/icon-192.png',
  },
  {
    name: 'bMusic',
    url: 'https://www.bmovies.app/bmusic',
    verb: 'Tokenise your music; fans who hold it make the video with you',
    group: 'featured',
    status: 'live',
    icon: bmusicIcon,
  },
  {
    name: 'bMint',
    url: 'https://www.bitcoin-mint.com/mint',
    verb: 'Design, stamp and mint tokens, currency and media on-chain',
    group: 'featured',
    status: 'live',
    icon: bmintIcon,
  },
  {
    name: 'bWriter',
    url: 'https://bitcoin-writer.com/',
    verb: 'Write and save documents on-chain',
    group: 'featured',
    status: 'live',
    icon: 'https://bitcoin-writer.com/favicon.svg',
    source: 'https://github.com/b0ase/bitcoin-writer',
  },
  // Work
  { name: 'bSheets', url: 'https://bitcoin-spreadsheet.vercel.app', verb: 'Spreadsheets saved on-chain', group: 'work', status: 'live', icon: bsheetsIcon, source: suite('bitcoin-spreadsheet') },
  { name: 'bMail', url: 'https://bitcoin-email.vercel.app', verb: 'Send email that pays and gets paid', group: 'work', status: 'live', icon: 'https://bitcoin-email.vercel.app/favicon.ico', source: suite('bitcoin-email') },
  { name: 'bDrive', url: 'https://bitcoin-drive.vercel.app', verb: 'Store and share files on-chain', group: 'work', status: 'live', icon: 'https://bitcoin-drive.vercel.app/favicon.ico', source: suite('bitcoin-drive') },
  { name: 'bCal', url: 'https://bitcoin-calendar.vercel.app', verb: 'Keep a calendar on Bitcoin', group: 'work', status: 'live', icon: bcalIcon, source: suite('bitcoin-calendar') },
  { name: 'bCode', url: 'https://bitcoin-code.vercel.app', verb: 'Build apps on Bitcoin', group: 'work', status: 'live', icon: 'https://bitcoin-code.vercel.app/favicon.svg?v=2', source: suite('bitcoin-code') },
  { name: 'bJobs', url: 'https://bitcoin-jobs.vercel.app', verb: 'Find work and hire, paid in BSV', group: 'work', status: 'live', source: suite('bitcoin-jobs') },
  { name: 'bID', url: 'https://bitcoin-identity.vercel.app', verb: 'Manage your on-chain identity', group: 'work', status: 'live', icon: 'https://bitcoin-identity.vercel.app/favicon.ico', source: suite('bitcoin-identity') },
  { name: 'bSearch', url: 'https://bitcoin-search.vercel.app', verb: 'Search what lives on-chain', group: 'work', status: 'live', icon: 'https://bitcoin-search.vercel.app/favicon.ico', source: suite('bitcoin-search') },
  { name: 'bDNS', url: 'https://bitcoin-dns.vercel.app', verb: 'Register and trade names on Bitcoin', group: 'work', status: 'live', icon: 'https://bitcoin-dns.vercel.app/favicon.ico', source: suite('bitcoin_dns') },
  // Media
  { name: 'bVideo', url: 'https://bitcoin-video-nine.vercel.app', verb: 'Watch and publish video', group: 'media', status: 'live', icon: bvideoIcon, source: suite('bitcoin-video') },
  { name: 'bRadio', url: 'https://bitcoin-radio.vercel.app', verb: 'Listen to and run Bitcoin radio', group: 'media', status: 'live', source: suite('bitcoin-radio') },
  { name: 'bPhotos', url: 'https://bitcoin-photos.vercel.app', verb: 'Turn photos into tradable NFTs', group: 'media', status: 'live', source: suite('bitcoin-photos') },
  { name: 'bArt', url: 'https://bitcoin-art.vercel.app', verb: 'Collect and show on-chain art', group: 'media', status: 'live', icon: 'https://bitcoin-art.vercel.app/favicon.ico', source: suite('bitcoin-art') },
  { name: 'bPaint', url: 'https://bitcoin-paint.vercel.app', verb: 'Paint and inscribe your work', group: 'media', status: 'live', icon: 'https://bitcoin-paint.vercel.app/favicon.ico', source: suite('bitcoin-paint') },
  { name: 'b3D', url: 'https://bitcoin-3d.vercel.app', verb: 'Model and own 3D designs', group: 'media', status: 'live', icon: 'https://bitcoin-3d.vercel.app/bitcoin-3d-logo.svg', source: suite('bitcoin-3d') },
  { name: 'bBooks', url: 'https://bitcoin-books-bay.vercel.app', verb: 'Read and publish books', group: 'media', status: 'live', icon: 'https://bitcoin-books-bay.vercel.app/favicon.svg', source: suite('bitcoin-books') },
  { name: 'bEdu', url: 'https://bitcoin-education-psi.vercel.app', verb: 'Learn and teach courses', group: 'media', status: 'demo', source: suite('bitcoin-education') },
  // Social & money
  { name: 'bSocial', url: 'https://bitcoin-social.vercel.app', verb: 'Post and follow on Bitcoin', group: 'social', status: 'live', source: suite('bitcoin-social') },
  { name: 'bGames', url: 'https://bitcoin-gaming.vercel.app', verb: 'Play games with real stakes', group: 'social', status: 'live', icon: 'https://bitcoin-gaming.vercel.app/favicon.ico', source: suite('bitcoin-gaming') },
  { name: 'bExchange', url: 'https://bitcoin-exchange-iota.vercel.app', verb: 'Trade tokens across exchanges', group: 'social', status: 'live', icon: 'https://bitcoin-exchange-iota.vercel.app/favicon.ico', source: suite('bitcoin-exchange') },
  { name: 'bMaps', url: 'https://bitcoin-maps.vercel.app', verb: 'Find places that take Bitcoin', group: 'social', status: 'live', source: suite('bitcoin-maps') },
];

export const bappsIn = (group: BAppGroup) => BAPPS.filter((a) => a.group === group);
