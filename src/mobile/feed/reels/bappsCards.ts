/**
 * Feed › bApps: a full-screen reel with one card per app in the bApps store (bapps.ts). Pure helpers here; the
 * view is BappsReel.tsx. Owner, 15 Oct 2026: apps are the meta. Each card shows the app (live preview or its
 * art), its builder and one line, then Open (the wallet's restricted bApp frame), Comment, Tip, Contribute
 * (open-source apps only) and Tokenise (the builder only, to the Launchpad prefilled).
 *
 * Sorts are neutral and user-chosen: New, Most paid to builder (rank-by-paying-artists: the total paid to the
 * builder, linear, no self-pay; 0 until the server reports it), A–Z.
 */
import type { BApp } from '../../bapps';

/** Who built an app. Our own suite is built by Bitcoin Corp, paid at the owner's handle. */
export type Builder = { name: string; handle?: string; paymail?: string };

export const BCORP_BUILDER: Builder = { name: 'Bitcoin Corp', handle: 'b0asex', paymail: 'b0asex@bwalletx.com' };

export type AppCard = {
  id: string;
  name: string;
  url: string;
  verb: string;
  icon?: string;
  /** GitHub repo (open source): shows Contribute. */
  source?: string;
  /** Runs in the bApp frame (false: the site refuses framing, so no live preview either). */
  frameable: boolean;
  /** An in-wallet route ('/m/…') rather than a website. */
  internal: boolean;
  builder: Builder;
  /** Position in the store list: lower = added earlier (the store has no dates yet). */
  order: number;
  /** Sats paid to the builder through tips on this app (server tally; 0 until reported). */
  paidSats: number;
  demo: boolean;
};

export type AppSort = 'new' | 'paid' | 'az';

export const APP_SORTS: readonly { id: AppSort; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'paid', label: 'Most paid to builder' },
  { id: 'az', label: 'A–Z' },
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Store entries → cards, in store order. */
export const appCards = (apps: readonly BApp[], paid: Record<string, number> = {}): AppCard[] =>
  apps.map((a, i) => {
    const id = slug(a.name);
    return {
      id,
      name: a.name,
      url: a.url,
      verb: a.verb,
      icon: a.icon,
      source: a.source,
      frameable: !a.noFrame && !a.url.startsWith('/'),
      internal: a.url.startsWith('/'),
      builder: BCORP_BUILDER,
      order: i,
      paidSats: Math.max(0, Number(paid[id]) || 0),
      demo: a.status === 'demo',
    };
  });

/** Sorted copy. New = latest added first; Most paid = highest total paid (ties: A–Z); A–Z by name. */
export const sortApps = (cards: readonly AppCard[], sort: AppSort): AppCard[] => {
  const az = (a: AppCard, b: AppCard) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  const out = [...cards];
  if (sort === 'az') return out.sort(az);
  if (sort === 'paid') return out.sort((a, b) => b.paidSats - a.paidSats || az(a, b));
  return out.sort((a, b) => b.order - a.order);
};

/** Contribute: the repo link plus a prefilled "suggest an improvement" issue. Null for closed-source apps. */
export const contributeLinks = (c: Pick<AppCard, 'source' | 'name'>): { repo: string; suggest: string } | null => {
  const s = c.source?.trim();
  if (!s || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(s)) return null;
  const repo = s.replace(/\/$/, '');
  const title = encodeURIComponent(`Suggestion for ${c.name}`);
  const body = encodeURIComponent('What would make this app better?\n\n(Sent from the bWalletX bApps feed.)');
  return { repo, suggest: `${repo}/issues/new?title=${title}&body=${body}` };
};

/** Is the signed-in person this app's builder? Compares paymails ($name = name@bwalletx.com), case-insensitive. */
export const isBuilder = (b: Builder, myNames: readonly (string | null | undefined)[]): boolean => {
  const norm = (s: string) => {
    const t = s.trim().toLowerCase().replace(/^\$/, '');
    return t.includes('@') ? t : `${t}@bwalletx.com`;
  };
  const theirs = [b.handle, b.paymail].filter((x): x is string => !!x).map(norm);
  if (!theirs.length) return false;
  return myNames.some((n) => !!n && theirs.includes(norm(n)));
};

/** Query string the Launchpad reads to prefill its form (launch.ts launchPrefill). */
export const tokeniseQuery = (c: Pick<AppCard, 'name' | 'verb' | 'url' | 'internal'>): string => {
  const sp = new URLSearchParams();
  sp.set('name', c.name.slice(0, 64));
  sp.set('description', c.verb.slice(0, 500));
  if (!c.internal && c.url.startsWith('https://')) sp.set('website', c.url);
  sp.set('category', 'apps');
  return `?${sp.toString()}`;
};

/** Where Comment goes: the app's discussion on bChatX. */
export const commentUrl = (c: Pick<AppCard, 'id'>) => `https://www.bchatx.com/u/${encodeURIComponent(c.id)}`;
