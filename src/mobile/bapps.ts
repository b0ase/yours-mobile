/**
 * The Bitcoin Corporation's own apps, shown on Apps › bApps. Add entries here.
 * Only status 'live' is shown; 'demo' entries stay hidden until promoted.
 */
export type BApp = {
  name: string;
  url: string;
  /** One line: what you do there. */
  verb: string;
  icon?: string;
  status: 'live' | 'demo';
  /** GitHub repo URL when open source; omit for closed source. */
  source?: string;
};

export const BAPPS: BApp[] = [
  {
    name: 'bChat',
    url: 'https://www.bitcoinchat.online',
    verb: 'Chat, voice and video messages, tokenised group chats',
    icon: 'https://www.bitcoinchat.online/bchat-apple-touch-icon.png',
    status: 'live',
  },
  {
    name: 'bMovies',
    url: 'https://www.bmovies.app',
    verb: 'Watch and back tokenised films',
    icon: 'https://www.bmovies.app/icons/icon-192.png',
    status: 'live',
  },
  {
    name: 'Bitcoin Writer',
    url: 'https://bitcoin-writer.com/',
    verb: 'Write and save documents on-chain',
    status: 'live',
    source: 'https://github.com/b0ase/bitcoin-writer',
  },
  {
    name: '1satsocial',
    url: 'https://1satsocial.online',
    verb: 'Trending 1Sat tokens and collections, with rooms',
    icon: 'https://1satsocial.online/favicon.ico',
    status: 'live',
  },
  { name: 'Bitcoin Spreadsheets', url: 'https://bitcoin-spreadsheet.vercel.app/', verb: 'Spreadsheets saved on-chain', status: 'demo' },
  { name: 'Bitcoin Email', url: 'https://bitcoin-email.vercel.app/', verb: 'Email over Bitcoin', status: 'demo' },
  { name: 'Bitcoin Drive', url: 'https://bitcoin-drive.vercel.app/', verb: 'Store files on-chain', status: 'demo' },
];

export const liveBApps = () => BAPPS.filter((a) => a.status === 'live');
