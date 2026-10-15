import type { Contact } from '../chat/contacts';
import { CAP, fill, getCapabilities, resolveOpns, type Fetch } from '../names/names';
import { listPaymails, type WalletName } from '../names/paymail';

/**
 * The address-book card (owner, 15 Oct 2026). The public half shows only what the person published or what
 * can be proven; anything we cannot check is either labelled "says …" or not shown at all. No placeholders.
 *
 * Sources, all public and read-only (nothing here signs, pays or posts):
 *  - bit-sign public profile  GET /api/public/profile/<handle>  → display name + avatar
 *  - paymail public profile   bsvalias f12f968c92d6              → name + avatar
 *  - paymail pki              bsvalias pki                       → identity key (when the contact has none)
 *  - bWalletX paymail lookup  listPaymails(identityKey)          → their other paymails; a `.x` name proves X
 *  - OpNS                     resolveOpns(name)                  → a name counts only when bound to their key
 */

export type PaymailPublic = { name?: string; avatar?: string; pubkey?: string };
export type BitsignPublic = {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Self-declared (bit-sign PR #270); shown as "says …". */
  bio?: string | null;
};
export type OpnsCheck = { name: string; pubkey?: string };
/** A company role. `verified` only when it was read from a public register we can check. */
export type BusinessRole = { company: string; role: string; verified: boolean; url?: string };

export type CardInputs = {
  contact: Contact;
  profile?: BitsignPublic | null;
  paymailProfile?: PaymailPublic | null;
  paymails?: WalletName[];
  /** OpNS lookups for candidate names; kept only when bound to this person's identity key. */
  opns?: OpnsCheck[];
  /** Hook: a Twetch account they claimed. Nothing supplies it yet, so nothing shows. */
  twetch?: string | null;
  /** Officer roles from bit-sign's public registers (GET /api/public/profile/<handle>/roles). */
  businesses?: BusinessRole[];
  /** Overrides the bit-sign profile bio (self-declared either way). */
  bio?: string | null;
};

export type CardView = {
  title: string;
  /** Main name: their paymail, else $handle. */
  main: string | null;
  avatars: string[];
  otherPaymails: string[];
  opnsNames: string[];
  /** X handle proven by an X sign-in (a `name.x` paymail is only claimable after Continue with X). */
  x: string | null;
  twetch: string | null;
  businesses: { label: string; verified: boolean; url: string | null }[];
  bio: string | null;
  identityKey: string | null;
};

const IMG = /^(https:\/\/|data:image\/)/i;
const KEY = /^0[23][0-9a-f]{64}$/i;
const OPNS_NAME = /^[a-z0-9-]{1,64}$/;

const clean = (s: string | null | undefined) => (s ?? '').trim();

export const identityKeyOf = (i: Pick<CardInputs, 'contact' | 'paymailProfile'>): string | null => {
  const k = clean(i.contact.identityKey) || clean(i.paymailProfile?.pubkey);
  return KEY.test(k) ? k.toLowerCase() : null;
};

/** Names worth asking OpNS about: their handle and the plain alias of each of their paymails. */
export const opnsCandidates = (c: Contact, paymails: WalletName[] = []): string[] => {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    const n = clean(s).toLowerCase().replace(/^\$/, '');
    if (OPNS_NAME.test(n)) out.add(n);
  };
  add(c.handle);
  add(c.paymail?.split('@')[0]);
  for (const p of paymails) if (p.kind === 'plain') add(p.paymail.split('@')[0]);
  return [...out];
};

export const businessLabel = (b: BusinessRole) =>
  b.verified ? `${b.role} · ${b.company}` : `says ${b.role} · ${b.company}`;

export const buildCard = (i: CardInputs): CardView => {
  const c = i.contact;
  const key = identityKeyOf(i);
  const main = c.paymail ? c.paymail.toLowerCase() : c.handle ? `$${c.handle}` : null;
  const avatars = [
    ...new Set([i.profile?.avatarUrl, i.paymailProfile?.avatar, c.avatar].map(clean).filter((u) => IMG.test(u))),
  ];
  const paymails = i.paymails ?? [];
  // `.gmail` names would publish an email address (owner): never shown.
  const otherPaymails = paymails
    .filter((p) => p.kind !== 'gmail' && p.paymail.toLowerCase() !== main)
    .map((p) => p.paymail.toLowerCase());
  const xName = paymails.find((p) => p.kind === 'x')?.paymail.split('@')[0];
  const x = xName ? `@${xName.replace(/\.x$/, '')}` : null;
  const opnsNames = key
    ? [...new Set((i.opns ?? []).filter((o) => clean(o.pubkey).toLowerCase() === key).map((o) => o.name))]
    : [];
  const title = clean(i.profile?.displayName) || clean(i.paymailProfile?.name) || clean(c.name) || main || 'Contact';
  return {
    title,
    main,
    avatars,
    otherPaymails,
    opnsNames,
    x,
    twetch: clean(i.twetch) || null,
    businesses: (i.businesses ?? [])
      .filter((b) => clean(b.company) && clean(b.role))
      .map((b) => ({
        label: businessLabel(b),
        verified: b.verified,
        url: /^https:\/\//i.test(clean(b.url)) ? clean(b.url) : null,
      })),
    bio: clean(i.bio) || clean(i.profile?.bio) || null,
    identityKey: key,
  };
};

// ── fetchers (injectable; every failure means "nothing to show") ──

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export const fetchPaymailPublic = async (f: Fetch, paymail: string): Promise<PaymailPublic | null> => {
  const [alias, domain] = paymail.toLowerCase().split('@');
  if (!alias || !domain) return null;
  try {
    const caps = await getCapabilities(f, domain);
    const get = async (cap: string) => {
      const tpl = str(caps[cap]);
      if (!tpl) return null;
      const r = await f(fill(tpl, alias, domain));
      return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    };
    const [prof, pki] = await Promise.all([get(CAP.publicProfile).catch(() => null), get(CAP.pki).catch(() => null)]);
    return { name: str(prof?.name), avatar: str(prof?.avatar), pubkey: str(pki?.pubkey) };
  } catch {
    return null;
  }
};

export const BITSIGN_PUBLIC = 'https://www.bitcoinchat.online/api/public/profile';

export const parseBitsignPublic = (d: unknown): BitsignPublic | null => {
  const o = d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  const handle = str(o?.handle);
  if (!handle) return null;
  return {
    handle,
    displayName: str(o?.displayName) ?? null,
    avatarUrl: str(o?.avatarUrl) ?? null,
    bio: str(o?.bio) ?? null,
  };
};

/** bit-sign roles JSON → verified rows (serving officers in public rooms, read from the register). */
export const parseRoles = (d: unknown): BusinessRole[] => {
  const roles = d && typeof d === 'object' ? (d as { roles?: unknown }).roles : null;
  if (!Array.isArray(roles)) return [];
  const out: BusinessRole[] = [];
  for (const x of roles) {
    const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
    const company = clean(str(o.name) ?? str(o.ticker));
    const role = clean(str(o.office_label) ?? str(o.office));
    if (!company || !role) continue;
    const url = clean(str(o.register_url));
    out.push({ company, role, verified: true, ...(/^https:\/\//i.test(url) ? { url } : {}) });
  }
  return out;
};

/** Roles without credentials (CORS allows the wallet origins); any failure, 404 included, means none. */
export const fetchRoles = async (f: Fetch, handle: string): Promise<BusinessRole[]> => {
  try {
    const r = await f(`${BITSIGN_PUBLIC}/${encodeURIComponent(handle)}/roles`, { credentials: 'omit' });
    return r.ok ? parseRoles(await r.json()) : [];
  } catch {
    return [];
  }
};

export type GetJson = (url: string) => Promise<unknown>;

/** Everything public about one contact, in parallel; any source that fails is simply left out. */
export const loadCardInputs = async (c: Contact, f: Fetch, getJson: GetJson): Promise<CardInputs> => {
  const safe = <T>(p: Promise<T>, d: T) => p.catch(() => d);
  const [profile, paymailProfile, businesses] = await Promise.all([
    c.handle
      ? safe(getJson(`${BITSIGN_PUBLIC}/${encodeURIComponent(c.handle)}`).then(parseBitsignPublic), null)
      : Promise.resolve(null),
    c.paymail ? fetchPaymailPublic(f, c.paymail) : Promise.resolve(null),
    c.handle ? fetchRoles(f, c.handle) : Promise.resolve([] as BusinessRole[]),
  ]);
  const key = identityKeyOf({ contact: c, paymailProfile });
  const paymails = key ? await safe(listPaymails(f, key), [] as WalletName[]) : [];
  const opns = key
    ? await Promise.all(
        opnsCandidates(c, paymails).map((name) =>
          safe(
            resolveOpns(f, name).then((r) => ({ name, pubkey: r.pubkey })),
            { name } as OpnsCheck,
          ),
        ),
      )
    : [];
  return { contact: c, profile, paymailProfile, paymails, opns, businesses };
};
