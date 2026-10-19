/**
 * The search bar at the top of Settings (owner, 19 Oct 2026): find a setting by its label, its description or a
 * common word for it ("seed" finds Show my 12 words). Each entry says where it opens.
 */

export type SettingsTarget =
  | { kind: 'page'; page: string }
  /** A screen owned by the phone / web settings (mobile/settings/FeedSettings.tsx). */
  | { kind: 'screen'; screen: string }
  | { kind: 'theme' };

export type SettingsEntry = {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  target: SettingsTarget;
};

const page = (p: string): SettingsTarget => ({ kind: 'page', page: p });

export const BASE_SETTINGS: SettingsEntry[] = [
  {
    id: 'show-words',
    label: 'Show my 12 words',
    description: 'See the recovery phrase for this account',
    keywords: [
      'seed',
      'seed phrase',
      'words',
      'recovery',
      'recovery phrase',
      'phrase',
      'mnemonic',
      'secret',
      'restore',
    ],
    target: page('show-words'),
  },
  {
    id: 'backup',
    label: 'Wallet Backup',
    description: 'Backup file, keys download, or QR code',
    keywords: ['backup', 'back up', 'export', 'download', 'keys', 'private key', 'wif', 'json', 'save'],
    target: page('export-keys-options'),
  },
  {
    id: 'export-qr',
    label: 'Export as QR Code',
    description: 'Show keys as a QR code for another device',
    keywords: ['qr', 'export', 'scan', 'keys', 'transfer'],
    target: page('export-keys-options'),
  },
  {
    id: 'remote-backup',
    label: 'Remote Backup',
    description: 'Automatic backup and storage providers',
    keywords: ['storage', 'cloud', 'sync', 'backup', 'provider'],
    target: page('storage'),
  },
  {
    id: 'accounts',
    label: 'Manage Accounts',
    description: 'Create, restore, or edit accounts',
    keywords: ['account', 'accounts', 'add account', 'new account', 'switch', 'restore', 'import', 'rename', 'delete'],
    target: page('manage-accounts'),
  },
  {
    id: 'permissions',
    label: 'Permissions',
    description: 'Connected apps and what they may do',
    keywords: ['apps', 'connected', 'sites', 'websites', 'revoke', 'disconnect', 'dapps'],
    target: page('permissions'),
  },
  {
    id: 'identity',
    label: 'Identity',
    description: 'Your name, posting profile and verification',
    keywords: ['profile', 'name', 'avatar', 'photo', 'picture', 'handle', 'paymail', 'verify', 'kyc', 'bap'],
    target: page('identity'),
  },
  {
    id: 'usb',
    label: 'USB Security Key',
    description: 'Two-factor unlock with a USB drive',
    keywords: ['usb', 'stick', 'drive', '2fa', 'two factor', 'hardware'],
    target: page('usb-security'),
  },
  {
    id: 'fee',
    label: 'Custom Fee Rate',
    description: 'Miner fee in sat/kb',
    keywords: ['fee', 'fees', 'miner', 'sat', 'sats', 'rate'],
    target: page('main'),
  },
  {
    id: 'autolock',
    label: 'Auto-lock',
    description: 'Lock the wallet after a while',
    keywords: ['lock', 'timeout', 'auto lock', 'idle', 'sleep'],
    target: page('main'),
  },
  {
    id: 'currency',
    label: 'Currency',
    description: 'Show amounts in dollars or pounds',
    keywords: ['currency', 'usd', 'gbp', 'dollar', 'pound', 'fiat', 'money'],
    target: page('main'),
  },
  {
    id: 'tax',
    label: 'Tax reports',
    description: 'Rules for History › Gains',
    keywords: ['tax', 'hmrc', 'gains', 'fifo'],
    target: page('main'),
  },
  {
    id: 'theme',
    label: 'Theme',
    description: 'App colours and your card design',
    keywords: ['theme', 'colour', 'color', 'colours', 'dark', 'light', 'appearance', 'card', 'look'],
    target: { kind: 'theme' },
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    description: 'Repair sync, missing coins or tokens, support',
    keywords: ['help', 'repair', 'fix', 'sync', 'missing', 'resync', 'support', 'bug', 'problem', 'recover'],
    target: page('troubleshooting'),
  },
];

/** Settings rows that exist only in some builds (the phone / web settings) add themselves here when loaded. */
const extra: SettingsEntry[] = [];
export const registerSettingsEntries = (entries: SettingsEntry[]) => {
  for (const e of entries) if (!extra.some((x) => x.id === e.id)) extra.push(e);
};
export const allSettingsEntries = (): SettingsEntry[] => [...BASE_SETTINGS, ...extra];

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Entries matching every word of the query, best first: a label match beats a keyword match beats a description
 * match, and a word-start match beats one in the middle of a word.
 */
export const searchSettings = (query: string, entries: SettingsEntry[] = allSettingsEntries()): SettingsEntry[] => {
  const terms = norm(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const scored: { e: SettingsEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const label = norm(e.label);
    const keys = e.keywords.map(norm);
    const desc = norm(e.description);
    let score = 0;
    for (const t of terms) {
      const starts = (s: string) => s === t || s.startsWith(t) || s.includes(` ${t}`);
      let best = 0;
      if (label === t) best = 12;
      else if (starts(label)) best = 10;
      else if (label.includes(t)) best = 6;
      if (keys.some((k) => k === t)) best = Math.max(best, 9);
      else if (keys.some(starts)) best = Math.max(best, 7);
      if (starts(desc)) best = Math.max(best, 4);
      else if (desc.includes(t)) best = Math.max(best, 2);
      if (!best) return;
      score += best;
    }
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
};

/**
 * Opening one of FeedSettings' screens from a search result. The settings list may not be mounted yet (the results
 * replace it), so the request waits here until FeedSettings mounts and takes it, or hears the event if it is up.
 */
export const SETTINGS_SCREEN_EVENT = 'bwx:settings-screen';
let pendingScreen: string | undefined;
export const requestSettingsScreen = (screen: string) => {
  pendingScreen = screen;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SETTINGS_SCREEN_EVENT));
};
export const takeSettingsScreen = (): string | undefined => {
  const s = pendingScreen;
  pendingScreen = undefined;
  return s;
};
