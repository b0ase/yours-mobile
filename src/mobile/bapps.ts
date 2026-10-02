import bphotosIcon from './brand/bphotos-icon.png';
import bradioIcon from './brand/bradio-icon.png';
import bdnsIcon from './brand/bdns-icon.png';
import bsearchIcon from './brand/bsearch-icon.png';
import bidIcon from './brand/bid-icon.png';
import bjobsIcon from './brand/apps/bjobs.png';
import bcodeIcon from './brand/apps/bcode.png';
import bdriveIcon from './brand/apps/bdrive.png';
import bvideoIcon from './brand/bvideo-icon.png';
import bcalIcon from './brand/apps/bcal.png';
import bsheetsIcon from './brand/apps/bsheets.png';
import bmintIcon from './brand/bmint-icon.png';
import bmusicIcon from './brand/bmusic-icon.png';
import app_bchatIcon from './brand/apps/bchat.png';
import app_bmoviesIcon from './brand/apps/bmovies.png';
import app_bwriterIcon from './brand/apps/bwriter.png';
import app_bmailIcon from './brand/apps/bmail.png';
import app_bartIcon from './brand/apps/bart.png';
import app_bpaintIcon from './brand/apps/bpaint.png';
import app_b3dIcon from './brand/apps/b3d.png';
import app_bbooksIcon from './brand/apps/bbooks.png';
import app_bgamesIcon from './brand/apps/bgames.png';
import app_bexchangeIcon from './brand/apps/bexchange.png';
import app_beduIcon from './brand/apps/bedu.png';
import app_bsocialIcon from './brand/apps/bsocial.png';
import app_bmapsIcon from './brand/apps/bmaps.png';
/**
 * The bApps store (Apps › bApps): The Bitcoin Corporation's own apps. Edit here.
 * status: 'live' = the site answered 200 with a real page when checked
 * (2026-10-01); 'demo' = not yet live. Demo apps are shown, labelled Demo.
 * icon: the app's original icon where it has a distinctive one, else a bCorp flag-cut b
 * (src/mobile/brand: 1st app of a colour = coloured b on black, 2nd = black b on the
 * colour, 3rd = white b on the colour, 4th = coloured b on white).
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
  /**
   * Opens full screen instead of inside bWallet's frame: the site sends X-Frame-Options or
   * CSP frame-ancestors that refuse the wallet (checked 2026-10-02). Remove once the site
   * allows `frame-ancestors capacitor://localhost https://localhost` (docs/BAPP-FRAME.md).
   * Sites without this flag are still probed at open time and fall back automatically.
   */
  noFrame?: boolean;
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
    noFrame: true,
    verb: 'Chat, voice and video messages, tokenised group chats',
    group: 'featured',
    status: 'live',
    icon: app_bchatIcon,
  },
  {
    name: 'bMovies',
    url: 'https://www.bmovies.app',
    noFrame: true,
    verb: 'Watch and back tokenised films',
    group: 'featured',
    status: 'live',
    icon: app_bmoviesIcon,
  },
  {
    name: 'bMusic',
    url: 'https://www.bmovies.app/bmusic',
    noFrame: true,
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
    icon: app_bwriterIcon,
    source: 'https://github.com/b0ase/bitcoin-writer',
  },
  // Work
  {
    name: 'bSheets',
    url: 'https://bitcoin-spreadsheet.vercel.app',
    verb: 'Spreadsheets saved on-chain',
    group: 'work',
    status: 'live',
    icon: bsheetsIcon,
    source: suite('bitcoin-spreadsheet'),
  },
  {
    name: 'bMail',
    url: 'https://bitcoin-email.vercel.app',
    noFrame: true,
    verb: 'Send email that pays and gets paid',
    group: 'work',
    status: 'live',
    icon: app_bmailIcon,
    source: suite('bitcoin-email'),
  },
  {
    name: 'bDrive',
    url: 'https://bitcoin-drive.vercel.app',
    noFrame: true,
    verb: 'Store and share files on-chain',
    group: 'work',
    status: 'live',
    icon: bdriveIcon,
    source: suite('bitcoin-drive'),
  },
  {
    name: 'bCal',
    url: 'https://bitcoin-calendar.vercel.app',
    verb: 'Keep a calendar on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bcalIcon,
    source: suite('bitcoin-calendar'),
  },
  {
    name: 'bCode',
    url: 'https://bitcoin-code.vercel.app',
    verb: 'Build apps on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bcodeIcon,
    source: suite('bitcoin-code'),
  },
  {
    name: 'bJobs',
    url: 'https://bitcoin-jobs.vercel.app',
    verb: 'Find work and hire, paid in BSV',
    group: 'work',
    status: 'live',
    icon: bjobsIcon,
    source: suite('bitcoin-jobs'),
  },
  {
    name: 'bID',
    url: 'https://bitcoin-identity.vercel.app',
    verb: 'Manage your on-chain identity',
    group: 'work',
    status: 'live',
    icon: bidIcon,
    source: suite('bitcoin-identity'),
  },
  {
    name: 'bSearch',
    url: 'https://bitcoin-search.vercel.app',
    verb: 'Search what lives on-chain',
    group: 'work',
    status: 'live',
    icon: bsearchIcon,
    source: suite('bitcoin-search'),
  },
  {
    name: 'bDNS',
    url: 'https://bitcoin-dns.vercel.app',
    verb: 'Register and trade names on Bitcoin',
    group: 'work',
    status: 'live',
    icon: bdnsIcon,
    source: suite('bitcoin_dns'),
  },
  // Media
  {
    name: 'bVideo',
    url: 'https://bitcoin-video-nine.vercel.app',
    verb: 'Watch and publish video',
    group: 'media',
    status: 'live',
    icon: bvideoIcon,
    source: suite('bitcoin-video'),
  },
  {
    name: 'bRadio',
    url: 'https://bitcoin-radio.vercel.app',
    verb: 'Listen to and run Bitcoin radio',
    group: 'media',
    status: 'live',
    icon: bradioIcon,
    source: suite('bitcoin-radio'),
  },
  {
    name: 'bPhotos',
    url: 'https://bitcoin-photos.vercel.app',
    verb: 'Turn photos into tradable NFTs',
    group: 'media',
    status: 'live',
    icon: bphotosIcon,
    source: suite('bitcoin-photos'),
  },
  {
    name: 'bArt',
    url: 'https://bitcoin-art.vercel.app',
    verb: 'Collect and show on-chain art',
    group: 'media',
    status: 'live',
    icon: app_bartIcon,
    source: suite('bitcoin-art'),
  },
  {
    name: 'bPaint',
    url: 'https://bitcoin-paint.vercel.app',
    verb: 'Paint and inscribe your work',
    group: 'media',
    status: 'live',
    icon: app_bpaintIcon,
    source: suite('bitcoin-paint'),
  },
  {
    name: 'b3D',
    url: 'https://bitcoin-3d.vercel.app',
    verb: 'Model and own 3D designs',
    group: 'media',
    status: 'live',
    icon: app_b3dIcon,
    source: suite('bitcoin-3d'),
  },
  {
    name: 'bBooks',
    url: 'https://bitcoin-books-bay.vercel.app',
    verb: 'Read and publish books',
    group: 'media',
    status: 'live',
    icon: app_bbooksIcon,
    source: suite('bitcoin-books'),
  },
  {
    name: 'bEdu',
    url: 'https://bitcoin-education-psi.vercel.app',
    verb: 'Learn and teach courses',
    group: 'media',
    status: 'demo',
    icon: app_beduIcon,
    source: suite('bitcoin-education'),
  },
  // Social & money
  {
    name: 'bSocial',
    url: 'https://bitcoin-social.vercel.app',
    verb: 'Post and follow on Bitcoin',
    group: 'social',
    status: 'live',
    icon: app_bsocialIcon,
    source: suite('bitcoin-social'),
  },
  {
    name: 'bGames',
    url: 'https://bitcoin-gaming.vercel.app',
    verb: 'Play games with real stakes',
    group: 'social',
    status: 'live',
    icon: app_bgamesIcon,
    source: suite('bitcoin-gaming'),
  },
  {
    name: 'bExchange',
    url: 'https://bitcoin-exchange-iota.vercel.app',
    verb: 'Trade tokens across exchanges',
    group: 'social',
    status: 'live',
    icon: app_bexchangeIcon,
    source: suite('bitcoin-exchange'),
  },
  {
    name: 'bMaps',
    url: 'https://bitcoin-maps.vercel.app',
    verb: 'Find places that take Bitcoin',
    group: 'social',
    status: 'live',
    icon: app_bmapsIcon,
    source: suite('bitcoin-maps'),
  },
];

export const bappsIn = (group: BAppGroup) => BAPPS.filter((a) => a.group === group);
