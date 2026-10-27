/**
 * Inline action buttons in b's replies, ported from bChatX (bit-sign src/lib/inline-actions.ts, PR #471; owner,
 * 26 Oct 2026: "I would like friendly buttons inline too"). b writes `[[Open tickets|/m/tickets]]`; the chat shows
 * a button instead.
 *
 * ⚠ A model's output is untrusted text, and a button is something people tap without reading. So a button may
 * only OPEN one of the wallet's own screens (an allow-list below), never act: no spend, sign or send happens on tap.
 * Anything money-related lands on its normal screen, which keeps its own confirm / approval step. Query strings
 * are dropped except a room ticker, so b can't pre-fill an amount or an address. Anything else (https://,
 * javascript:, //host, a screen not listed) is dropped and its label left as words. Pure: renderer + tests.
 */
export interface InlineAction {
  label: string;
  href: string;
}

const TOKEN = /\[\[([^[\]|]{1,40})\|([^[\]\s]{1,300})\]\]/g;
export const MAX_ACTIONS = 4;

/** Screens a button may open (first path segment under /m/). Read/browse screens; none spends on open. */
export const SAFE_SCREENS = [
  'home',
  'chat',
  'feed',
  'settings',
  'credits',
  'ask-b',
  'tickets',
  'names',
  'my-names',
  'nfts',
  'market',
  'apps',
  'reports',
  'you',
  'friends',
  'notes',
  'media',
  'people',
  'notifications',
  'calendar',
  'spaces',
  'store',
  'bmail',
  'lock',
] as const;

/** The in-app path to open, or null if this target is not allowed. `bwalletx://x/y` maps to `/m/x/y`. */
export function safeTarget(href: string): string | null {
  let path = href.trim();
  const app = /^bwalletx:\/\/(.*)$/i.exec(path);
  if (app) path = `/m/${app[1]}`;
  if (!/^\/m(\/|$)/.test(path) || /[\\]|\/\/|\.\./.test(path)) return null;
  const [rawPath, query = ''] = path.split(/[?#]/, 2);
  if (!/^\/m(\/[\w\-.$@]+)*\/?$/.test(rawPath)) return null;
  const screen = rawPath.split('/')[2] || 'home';
  if (!(SAFE_SCREENS as readonly string[]).includes(screen)) return null;
  // Only `?room=TICKER` survives (opening a room); every other parameter is dropped.
  const room = /(?:^|&)room=([A-Za-z0-9_$.-]{1,40})(?:&|$)/.exec(query);
  return screen === 'chat' && room ? `${rawPath}?room=${room[1]}` : rawPath;
}

export const isSafeTarget = (href: string) => safeTarget(href) !== null;

/** Split a reply into its text (tokens removed) and up to four safe buttons. */
export function parseInlineActions(text: string): { text: string; actions: InlineAction[] } {
  const actions: InlineAction[] = [];
  const seen = new Set<string>();
  const out = text.replace(TOKEN, (_m, rawLabel: string, rawHref: string) => {
    const label = rawLabel.trim();
    if (!label) return '';
    const href = safeTarget(rawHref);
    if (!href) return label;
    if (actions.length < MAX_ACTIONS && !seen.has(href)) {
      seen.add(href);
      actions.push({ label, href });
    }
    return '';
  });
  return {
    text: out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    actions,
  };
}

/** What b is told about buttons (appended to its system prompt). */
export const INLINE_ACTIONS_PROMPT = [
  '\n\nBUTTONS: when a reply points to a screen the person can open next, add up to 3 buttons on their own line,',
  'written exactly as [[Label|/m/screen]] (a short label, 1–4 words). Only these screens:',
  '/m/home, /m/chat (or /m/chat?room=TICKER for a room), /m/feed, /m/settings, /m/tickets, /m/names, /m/nfts,',
  '/m/market, /m/apps, /m/credits, /m/you. A button only opens the screen; it never sends, pays or signs, so never',
  'promise that it will. Never put a full https:// address in a button. Add them only when there is a clear next step.',
].join(' ');
