import bwalletIcon from '../brand/sources/bwallet.png';
import otherIcon from '../brand/sources/other.png';
import treechatIcon from '../brand/sources/treechat.png';
import twetchIcon from '../brand/sources/twetch.png';

/**
 * Feed sources: one entry per app a post can come from (MAP `app`). Adding a syndicated feed
 * is one entry here: how to recognise its MAP app, its label and bundled 64px logo
 * (src/mobile/brand/sources/, never hotlinked), and where its original post lives.
 */
export type Source = 'bwallet' | 'treechat' | 'twetch' | 'other';

export type SourceInfo = {
  id: Source;
  label: string;
  icon: string;
  color?: string;
  /** Does this MAP app value belong to the source? (lower-cased, trimmed) */
  matches: (app: string) => boolean;
  /** Link to the original post on the source app, where a URL pattern is known. */
  postUrl: (p: { txid: string; threadId: string | null }) => string | null;
};

export const FEED_APP = 'bWallet';

export const SOURCE_REGISTRY: Record<Source, SourceInfo> = {
  bwallet: {
    id: 'bwallet',
    label: 'bWallet',
    icon: bwalletIcon,
    color: '#FFD24D',
    matches: (a) => a === FEED_APP.toLowerCase(),
    postUrl: () => null,
  },
  treechat: {
    id: 'treechat',
    label: 'Treechat',
    icon: treechatIcon,
    color: '#8D7FE3',
    matches: (a) => a === 'treechat' || a.startsWith('treechat_'),
    // Verified: app.treechat.com/p/<thread id> redirects to /quest/<thread id>.
    postUrl: (p) => (p.threadId ? `https://app.treechat.com/p/${p.threadId}` : null),
  },
  twetch: {
    id: 'twetch',
    label: 'Twetch',
    icon: twetchIcon,
    matches: (a) => a === 'twetch',
    // The form Twetch users shared on-chain.
    postUrl: (p) => `https://twetch.com/t/${p.txid}`,
  },
  other: {
    id: 'other',
    label: 'Other',
    icon: otherIcon,
    matches: () => true,
    postUrl: () => null,
  },
};

/** Match order: specific sources first, "other" last. */
const ORDER: Source[] = ['bwallet', 'treechat', 'twetch', 'other'];

export const SOURCES: { id: Source | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  ...ORDER.map((id) => ({ id, label: SOURCE_REGISTRY[id].label })),
];

/** Pretty names for "other" apps we know by name. */
const APP_LABELS: Record<string, string> = {
  '1satsocial': '1satsocial',
  '1sat.social': '1satsocial',
  bsocial: 'bSocial',
};

export function sourceOf(app: string): Source {
  const a = app.trim().toLowerCase();
  return ORDER.find((id) => id !== 'other' && SOURCE_REGISTRY[id].matches(a)) ?? 'other';
}

export const sourceInfo = (app: string): SourceInfo => SOURCE_REGISTRY[sourceOf(app)];

/** "Treechat" for the credit line; unknown apps keep their own (trimmed) name; ours / empty → ''. */
export const sourceLabel = (app: string): string => {
  const a = app.trim();
  const s = sourceOf(a);
  if (!a || s === 'bwallet') return '';
  if (s !== 'other') return SOURCE_REGISTRY[s].label;
  return APP_LABELS[a.toLowerCase()] ?? a.slice(0, 24);
};

export function sourceUrl(p: { source: Source; threadId: string | null; txid: string }): string | null {
  return SOURCE_REGISTRY[p.source].postUrl(p);
}
