/**
 * Token links: website, X, Telegram, bChat room and app for a token, when its issuer published them.
 *
 * Today no source carries these yet (8 Oct 2026): BSV-21 deploy inscriptions hold p/op/amt/sym/icon/dec,
 * TokenBlaster's /api/launch/coin has no link fields, bit-sign token rooms keep none. The reader accepts
 * the field names proposed in docs/LAUNCH-SOCIAL-PLAN.md, top level or under `links`, so links appear as
 * soon as an issuer (or TokenBlaster) publishes them, and nothing shows until then.
 *
 * Only these five kinds are read: any company, equity or shares field is ignored (owner, 8 Oct 2026:
 * a token that stands for a company is a security; that belongs to $403, not ordinary tokens).
 *
 * Safety: https only, no credentials in the URL, a real hostname, X and Telegram only on their own
 * domains (a bare handle is turned into the profile URL). The label is the domain, never issuer text.
 */
export type LinkKind = 'website' | 'x' | 'telegram' | 'bchat' | 'app';
export type TokenLink = { kind: LinkKind; url: string; label: string };

export const LINK_ORDER: LinkKind[] = ['website', 'app', 'x', 'telegram', 'bchat'];
const KEYS: Record<LinkKind, string[]> = {
  website: ['website', 'web', 'site', 'url', 'homepage'],
  app: ['app', 'appurl', 'app_url'],
  x: ['x', 'twitter'],
  telegram: ['telegram', 'tg'],
  bchat: ['bchat', 'bchatroom', 'bchat_room', 'room'],
};
const HOSTS: Partial<Record<LinkKind, string[]>> = {
  x: ['x.com', 'twitter.com'],
  telegram: ['t.me', 'telegram.me'],
};
const HANDLE = /^@?([A-Za-z0-9_]{1,32})$/;

/** A safe https URL, or null. */
export const safeHttps = (raw: unknown): URL | null => {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  return u;
};

const hostOk = (host: string, allowed: string[]) =>
  allowed.some((a) => host === a || host === `www.${a}` || host === `mobile.${a}`);

/** One field's value as a link, or null. */
export const toLink = (kind: LinkKind, raw: unknown): TokenLink | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  const allowed = HOSTS[kind];
  if (allowed) {
    const h = v.match(HANDLE);
    if (h) {
      const url = kind === 'x' ? `https://x.com/${h[1]}` : `https://t.me/${h[1]}`;
      return { kind, url, label: `@${h[1]}` };
    }
  }
  const u = safeHttps(v);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (allowed && !hostOk(u.hostname.toLowerCase(), allowed)) return null;
  return { kind, url: u.toString(), label: host };
};

const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const [k, v] of Object.entries(o)) if (keys.includes(k.toLowerCase())) return v;
  return undefined;
};

/** Links from any metadata objects (first source wins per kind). Unknown or unsafe values are dropped. */
export const parseLinks = (...sources: unknown[]): TokenLink[] => {
  const found = new Map<LinkKind, TokenLink>();
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const o = src as Record<string, unknown>;
    const nested = o.links && typeof o.links === 'object' ? (o.links as Record<string, unknown>) : {};
    for (const kind of LINK_ORDER) {
      if (found.has(kind)) continue;
      const l = toLink(kind, pick(nested, KEYS[kind]) ?? pick(o, KEYS[kind]));
      if (l) found.set(kind, l);
    }
  }
  return LINK_ORDER.flatMap((k) => (found.has(k) ? [found.get(k)!] : []));
};

const deployCache = new Map<string, Promise<unknown>>();
/** The token's BSV-21 deploy inscription JSON (GorillaPool), cached per session; null when unavailable. */
export const fetchDeployJson = (tokenId: string): Promise<unknown> => {
  const id = tokenId.replace('.', '_');
  if (!/^[0-9a-f]{64}_\d+$/.test(id)) return Promise.resolve(null);
  let p = deployCache.get(id);
  if (!p) {
    p = fetch(`https://ordinals.gorillapool.io/api/txos/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j?.origin?.data?.insc?.json ?? j?.data?.insc?.json ?? null)
      .catch(() => null);
    deployCache.set(id, p);
  }
  return p;
};

/** Max length of the issuer-stated Utility line. */
export const UTILITY_MAX = 160;
/**
 * The issuer's own "Utility" statement (plain text, one line, capped), shown as "Issuer says: …".
 * bWalletX doesn't verify or endorse it. By default a token confers one right: entry to its chat room.
 */
export const parseUtility = (...sources: unknown[]): string | null => {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const v = (src as Record<string, unknown>).utility;
    if (typeof v !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const t = v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) return t.length > UTILITY_MAX ? `${t.slice(0, UTILITY_MAX - 1)}…` : t;
  }
  return null;
};
