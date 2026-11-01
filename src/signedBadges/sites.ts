/**
 * Which sites draw badges, and the small URL parsers the content script and the background share. Pure.
 */

export type Platform = 'X' | 'LinkedIn' | 'GitHub' | 'YouTube';

const HOSTS: [RegExp, Platform][] = [
  [/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/, 'X'],
  [/^(?:www\.)?linkedin\.com$/, 'LinkedIn'],
  [/^github\.com$/, 'GitHub'],
  [/^(?:www\.|m\.)?youtube\.com$/, 'YouTube'],
];

/** The badge site this host belongs to, if any. */
export const badgeSiteFor = (host: string): Platform | undefined =>
  HOSTS.find(([re]) => re.test(host.toLowerCase()))?.[1];

/** A name for the sheet: the platform, or the bare host. */
export const platformFor = (host: string): string => badgeSiteFor(host) ?? host.toLowerCase().replace(/^www\./, '');

/** The status id in an X post address: x.com/<user>/status/<id>[/...]. */
export const xStatusIdFromUrl = (href: string): string | undefined => {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,25})(?:[/?#]|$)/.exec(
    href,
  );
  return m?.[1];
};

/** The author handle in an X post address. */
export const xHandleFromUrl = (href: string): string | undefined => {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/\d{1,25}(?:[/?#]|$)/.exec(
    href,
  );
  return m?.[1];
};

/** The signed-in X user, from the profile link in X's tab bar ("/handle"). */
export const xHandleFromProfileHref = (href: string | null | undefined): string | undefined => {
  if (!href) return undefined;
  const path = href.startsWith('http') ? new URL(href).pathname : href;
  const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(path);
  return m?.[1];
};

/** "x.com/i/web/status/…" and friends are not a user page. */
const X_RESERVED = new Set(['i', 'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose']);
export const isXUserHandle = (h: string | undefined): h is string => !!h && !X_RESERVED.has(h.toLowerCase());
