/**
 * Public deep links that open one of our bApps inside the wallet frame:
 *   https://web.bwalletx.com/bapp/bchatx?to=/u/bmovies  →  https://www.bchatx.com/u/bmovies in the frame.
 * Pure (no DOM) so it can be unit-tested. `to` is a path on the bApp's own origin only.
 */
export type BappLinkTarget = { name: string; origin: string };

/** Slug in /bapp/<slug> → the bApp it opens. The frame src is built on this exact origin (no redirects in-frame). */
export const BAPP_LINKS: Record<string, BappLinkTarget> = {
  bchatx: { name: 'bChatX', origin: 'https://www.bchatx.com' },
};

const MAX_TO = 512;

/** A safe same-site path ("/u/bmovies?x=1#y"), or null: must start with one "/", no scheme, no "//", no "\\". */
export const safeBappPath = (to: string | null | undefined): string | null => {
  if (typeof to !== 'string' || to.length === 0 || to.length > MAX_TO) return null;
  if (!to.startsWith('/') || to.startsWith('//')) return null;
  if (to.includes('\\') || to.includes('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(to)) return null;
  try {
    const u = new URL(to, 'https://bapp.invalid');
    if (u.origin !== 'https://bapp.invalid') return null;
  } catch {
    return null;
  }
  return to;
};

/** /bapp/<slug>?to=… → the bApp and the URL to frame (bad or missing `to` → the bApp's home), or null for unknown slugs. */
export const resolveBappLink = (
  slug: string | undefined,
  to: string | null,
): { name: string; origin: string; url: string } | null => {
  const t = slug ? BAPP_LINKS[slug.toLowerCase()] : undefined;
  if (!t) return null;
  const path = safeBappPath(to);
  return { ...t, url: path ? `${t.origin}${path}` : `${t.origin}/` };
};
