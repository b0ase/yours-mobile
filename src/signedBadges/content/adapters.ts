/**
 * Find posts, comments and descriptions on the badge sites. Selectors are best effort (these sites change their
 * markup often); a post we can't read simply gets no badge. Read-only: nothing here changes the page.
 */
import {
  badgeSiteFor,
  isXUserHandle,
  xHandleFromProfileHref,
  xHandleFromUrl,
  xStatusIdFromUrl,
  type Platform,
} from '../sites';

export type FoundPost = {
  platform: Platform;
  /** The post container (for the badge's identity and visibility). */
  el: Element;
  /** The element holding the post's text. */
  textEl: Element;
  /** Where the badge goes (after it). */
  anchor: Element;
  /** The text we sign for this post (AuthSig's: textContent; trimmed off X). */
  signText: string;
  /** Text variants for matching. */
  texts: string[];
  /** Single text nodes of 20+ characters (AuthSig hashes those for selected-text proofs). */
  nodes: string[];
  truncated: boolean;
  /** The signed-in user wrote it (only known on X and GitHub). */
  mine: boolean;
  xStatusId?: string;
  authorHandle?: string;
};

/** textContent with image alt text kept (X draws emoji as <img alt="😎">) and <br> as a line break. */
export const textWithAlts = (el: Node): string => {
  let out = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const e = n as Element;
      if (e.tagName === 'IMG') out += e.getAttribute('alt') ?? '';
      else if (e.tagName === 'BR') out += '\n';
      else if (e.tagName !== 'SCRIPT' && e.tagName !== 'STYLE' && !e.hasAttribute('data-bwx-sb'))
        e.childNodes.forEach(walk);
    }
  };
  walk(el);
  return out;
};

const ownText = (el: Element): string => {
  // Our own badge never counts as post text.
  if (!el.querySelector('[data-bwx-sb]')) return el.textContent ?? '';
  return textWithAlts(el).replace(/\n/g, '');
};

const longNodes = (el: Element, max = 6): string[] => {
  const out: string[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n && out.length < max; n = w.nextNode()) {
    const t = (n.nodeValue ?? '').trim();
    if (t.length >= 20) out.push(t);
  }
  return out;
};

/** The shallowest match under `root` (a quoted post's text sits deeper than the post's own). */
const shallowest = (root: Element, sel: string): Element | null => {
  let best: Element | null = null;
  let bestDepth = Infinity;
  root.querySelectorAll(sel).forEach((e) => {
    let d = 0;
    for (let p = e.parentElement; p && p !== root; p = p.parentElement) d++;
    if (d < bestDepth) {
      bestDepth = d;
      best = e;
    }
  });
  return best;
};

const post = (
  platform: Platform,
  el: Element,
  textEl: Element | null,
  anchor: Element | null,
  extra: Partial<FoundPost> = {},
): FoundPost | undefined => {
  if (!textEl) return undefined;
  const raw = ownText(textEl);
  if (!raw.trim()) return undefined;
  const alts = textWithAlts(textEl);
  return {
    platform,
    el,
    textEl,
    anchor: anchor ?? textEl,
    signText: platform === 'X' ? raw : raw.trim(),
    texts: [...new Set([raw, alts])],
    nodes: longNodes(textEl),
    truncated: false,
    mine: false,
    ...extra,
  };
};

const xPosts = (): FoundPost[] => {
  const me = xHandleFromProfileHref(
    document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href'),
  )?.toLowerCase();
  const out: FoundPost[] = [];
  document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach((article) => {
    // The post's own link is the one around its <time>; other status links are quotes or replies.
    const link = article.querySelector('a[href*="/status/"] time')?.closest('a') as HTMLAnchorElement | null;
    const href = link?.href ?? '';
    const xStatusId = xStatusIdFromUrl(href);
    if (!xStatusId) return;
    const handle = xHandleFromUrl(href);
    const found = post(
      'X',
      article,
      shallowest(article, '[data-testid="tweetText"]'),
      article.querySelector('[data-testid="User-Name"]'),
      {
        xStatusId,
        authorHandle: isXUserHandle(handle) ? handle : undefined,
        truncated: !!article.querySelector('[data-testid="tweet-text-show-more-link"]'),
        mine: !!me && handle?.toLowerCase() === me,
      },
    );
    if (found) out.push(found);
  });
  return out;
};

const COMMENT = 'article.comments-comment-entity, article.comments-comment-item';
const linkedInPosts = (): FoundPost[] => {
  const out: FoundPost[] = [];
  document.querySelectorAll('div[data-urn^="urn:li:activity:"], div[data-id^="urn:li:activity:"]').forEach((el) => {
    const textEl = [...el.querySelectorAll('.update-components-text, .feed-shared-update-v2__description')].find(
      (t) => !t.closest(COMMENT),
    );
    const found = post(
      'LinkedIn',
      el,
      textEl ?? null,
      el.querySelector('.update-components-actor__title, .update-components-actor__name'),
      {
        truncated: !!el.querySelector(
          '.feed-shared-inline-show-more-text__see-more-less-toggle[aria-expanded="false"]',
        ),
      },
    );
    if (found) out.push(found);
  });
  document.querySelectorAll(COMMENT).forEach((el) => {
    const found = post(
      'LinkedIn',
      el,
      el.querySelector('.comments-comment-item__main-content, .update-components-text'),
      el.querySelector('.comments-comment-meta__description-title, .comments-post-meta__name-text'),
    );
    if (found) out.push(found);
  });
  return out;
};

const gitHubPosts = (): FoundPost[] => {
  const me = document.querySelector('meta[name="user-login"]')?.getAttribute('content')?.toLowerCase() || undefined;
  const out: FoundPost[] = [];
  const seen = new Set<Element>();
  document
    .querySelectorAll(
      '.timeline-comment, .js-comment-container, [data-testid="issue-body"], [data-testid^="comment-viewer-outer-box"], .react-issue-comment',
    )
    .forEach((el) => {
      const textEl = el.querySelector('.comment-body, [data-testid="markdown-body"], .markdown-body');
      if (!textEl || seen.has(textEl)) return;
      seen.add(textEl);
      const authorEl = el.querySelector(
        'a.author, a[data-testid="issue-body-header-author"], a[data-testid="avatar-link"], [data-testid="author-link"]',
      );
      const author = authorEl?.textContent?.trim().replace(/^@/, '');
      const found = post('GitHub', el, textEl, authorEl, {
        authorHandle: author || undefined,
        mine: !!me && author?.toLowerCase() === me,
      });
      if (found) out.push(found);
    });
  return out;
};

const youTubePosts = (): FoundPost[] => {
  const out: FoundPost[] = [];
  document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer').forEach((el) => {
    const found = post(
      'YouTube',
      el,
      el.querySelector('#content-text'),
      el.querySelector('#header-author h3, #author-text'),
      { truncated: !!el.querySelector('#more:not([hidden]), tp-yt-paper-button#more:not([hidden])') },
    );
    if (found) out.push(found);
  });
  const meta = document.querySelector('ytd-watch-metadata');
  const expander = meta?.querySelector('#description-inline-expander');
  if (meta && expander) {
    const found = post(
      'YouTube',
      expander,
      expander.querySelector('#expanded yt-attributed-string, yt-attributed-string, #expanded'),
      meta.querySelector('#title h1, h1'),
      { truncated: !expander.hasAttribute('is-expanded') },
    );
    if (found) out.push(found);
  }
  return out;
};

/** Every readable post on this page (top frame of a badge site only). */
export const findPosts = (host: string): FoundPost[] => {
  switch (badgeSiteFor(host)) {
    case 'X':
      return xPosts();
    case 'LinkedIn':
      return linkedInPosts();
    case 'GitHub':
      return gitHubPosts();
    case 'YouTube':
      return youTubePosts();
    default:
      return [];
  }
};

/** Signing from a post's own button: only where we can tell the post is the user's (X, GitHub). */
export const canSignHere = (p: FoundPost): boolean => p.mine && (p.platform === 'X' || p.platform === 'GitHub');
