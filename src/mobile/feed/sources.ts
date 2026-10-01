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

/**
 * Per-post actions. On-chain ones are Bitcoin Schema transactions signed by the user with
 * `app=bWallet` (never as the source app). `bookmark` and `unlock` live on the source's own
 * servers (Twetch bookmarks, Twetch paid unlocks), so they open the post in the source app.
 */
export type PostAction =
  | 'reply'
  | 'like'
  | 'branch'
  | 'quote'
  | 'tip'
  | 'lock'
  | 'copyLink'
  | 'open'
  | 'bookmark'
  | 'unlock'
  | 'report'
  | 'mute';

/** Actions on the row, and the rest under the "…" menu, in display order. */
export type SourceActions = { row: PostAction[]; more: PostAction[] };

/** Actions that need the source's own servers: they open the post in the source app. */
export const REMOTE_ACTIONS: ReadonlySet<PostAction> = new Set(['bookmark', 'unlock']);

/** Actions that need a link to the original post. */
const LINK_ACTIONS: ReadonlySet<PostAction> = new Set(['copyLink', 'open', 'bookmark', 'unlock']);

const BASIC: SourceActions = { row: ['reply', 'like', 'tip', 'lock'], more: ['open', 'copyLink', 'report', 'mute'] };

export type SourceInfo = {
  id: Source;
  label: string;
  icon: string;
  color?: string;
  /** Does this MAP app value belong to the source? (lower-cased, trimmed) */
  matches: (app: string) => boolean;
  /** Link to the original post on the source app, where a URL pattern is known. */
  postUrl: (p: { txid: string; threadId: string | null }) => string | null;
  /** Which actions a post from this source supports. */
  actions: SourceActions;
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
    actions: BASIC,
  },
  treechat: {
    id: 'treechat',
    label: 'Treechat',
    icon: treechatIcon,
    color: '#8D7FE3',
    matches: (a) => a === 'treechat' || a.startsWith('treechat_'),
    // Verified: app.treechat.com/p/<thread id> redirects to /quest/<thread id>.
    postUrl: (p) => (p.threadId ? `https://app.treechat.com/p/${p.threadId}` : null),
    actions: BASIC,
  },
  twetch: {
    id: 'twetch',
    label: 'Twetch',
    icon: twetchIcon,
    matches: (a) => a === 'twetch',
    // The form Twetch users shared on-chain.
    postUrl: (p) => `https://twetch.com/t/${p.txid}`,
    // Twetch's own post menu (twetch.com app bundle): reply, like, branch / quote ("Branch
    // options"), tip, copy link, bookmark, paid unlock, mute, report. Bookmarks and paid
    // unlocks are Twetch-server state, so they open the post in Twetch.
    actions: {
      row: ['reply', 'like', 'branch', 'tip', 'lock'],
      more: ['quote', 'copyLink', 'open', 'bookmark', 'unlock', 'report', 'mute'],
    },
  },
  other: {
    id: 'other',
    label: 'Other',
    icon: otherIcon,
    matches: () => true,
    postUrl: () => null,
    actions: BASIC,
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

/** A post's actions: its source's list, minus link actions when there is no original-post link. */
export function postActions(p: { source: Source; threadId: string | null; txid: string }): SourceActions {
  const info = SOURCE_REGISTRY[p.source] ?? SOURCE_REGISTRY.other;
  const linked = !!info.postUrl(p);
  const keep = (a: PostAction) => linked || !LINK_ACTIONS.has(a);
  return { row: info.actions.row.filter(keep), more: info.actions.more.filter(keep) };
}

export const ACTION_LABELS: Record<PostAction, string> = {
  reply: 'Reply',
  like: 'Like',
  branch: 'Branch',
  quote: 'Quote',
  tip: 'Tip',
  lock: 'Lock',
  copyLink: 'Copy link',
  open: 'Open in',
  bookmark: 'Bookmark in',
  unlock: 'Unlock paid content in',
  report: 'Report post',
  mute: 'Mute',
};

/** Menu label, naming the source app where the action happens there ("Open in Twetch"). */
export const actionLabel = (a: PostAction, source: Source): string =>
  a === 'open' || a === 'bookmark' || a === 'unlock'
    ? `${ACTION_LABELS[a]} ${SOURCE_REGISTRY[source].label}`
    : ACTION_LABELS[a];
