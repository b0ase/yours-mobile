/**
 * Friends (Desktop /wallet/friends, docs/FRIENDS.md): the pure half. Builds the friend cards from the merged
 * address book (chat/contacts.ts) plus what this device already knows (recent payees, DMs, cached history,
 * local nicknames / notes / favourites), suggestions, sorting, the add-friend input and the lookalike guard.
 * No network, no DOM: unit-tested in model.test.ts.
 */
import { lookalikes } from '../names/names';
import type { Contact } from '../chat/contacts';

/* ── Privacy ─────────────────────────────────────────────────────────────────────────── */

/** A verified Google name (`alice.gmail`) spells out alice@gmail.com: it is never shown or put in a URL. */
export const isEmailHandle = (h: string | null | undefined) => /\.gmail(@|$)/i.test((h || '').replace(/^\$/, ''));

const GMAIL = /^([^@\s]+)@(gmail|googlemail)\.com$/i;

/** Hide anything that reads as an email address: Gmail paymails and `.gmail` names keep only their first letter. */
export const maskEmail = (s: string | null | undefined): string => {
  const v = (s || '').trim();
  if (!v) return '';
  const g = GMAIL.exec(v);
  if (g) return `${g[1][0]}•••@${g[2].toLowerCase()}.com`;
  const h = /^(\$?)([^.\s@]+)((?:\.[^.\s@]+)*)\.gmail(@.*)?$/i.exec(v);
  if (h) return `${h[1]}${h[2][0]}•••.gmail${h[4] ?? ''}`;
  return v;
};

/** A paymail at a mail provider, or an email typed as a name: masked. Everything else unchanged. */
export const safeText = (s: string | null | undefined) => maskEmail(s);

/* ── Handles ─────────────────────────────────────────────────────────────────────────── */

/** `b0asex.x` is the name someone verified with Continue with X: they are @b0asex on X. */
export const socialHandle = (handle: string | null | undefined): string | null => {
  const m = /^([a-z0-9_]{1,15})\.x$/i.exec((handle || '').replace(/^\$/, ''));
  return m ? `@${m[1]}` : null;
};

/** URL slug for a friend: their $handle; a .gmail name never goes in the address bar (the key does). */
export const friendSlug = (c: Pick<Contact, 'handle' | 'identityKey' | 'address' | 'id'>): string => {
  if (c.handle && !isEmailHandle(c.handle)) return c.handle;
  return c.identityKey ?? c.address ?? c.id;
};

export const findBySlug = <T extends { contact: Contact }>(list: T[], slug: string): T | undefined => {
  const s = decodeURIComponent(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\$/, '');
  if (!s) return undefined;
  return list.find(
    (f) =>
      friendSlug(f.contact).toLowerCase() === s ||
      f.contact.handle === s ||
      f.contact.identityKey === s ||
      f.contact.id.toLowerCase() === s,
  );
};

/* ── Local-only notes, nicknames, dismissed suggestions ──────────────────────────────── */

export type LocalFriendData = {
  nicknames: Record<string, string>;
  notes: Record<string, string>;
  dismissed: string[];
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const LOCAL_KEY = (acct: string) => `bwallet.friends.local.${acct}`;
const EMPTY: LocalFriendData = { nicknames: {}, notes: {}, dismissed: [] };

const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const strMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object'
    ? (Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string'),
      ) as Record<string, string>)
    : {};

export const loadLocal = (acct: string, s: Store | null = storage()): LocalFriendData => {
  if (!acct || !s) return { ...EMPTY };
  try {
    const v = JSON.parse(s.getItem(LOCAL_KEY(acct)) ?? '{}') as Partial<LocalFriendData>;
    return {
      nicknames: strMap(v.nicknames),
      notes: strMap(v.notes),
      dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter((x) => typeof x === 'string').slice(-200) : [],
    };
  } catch {
    return { ...EMPTY };
  }
};

export const saveLocal = (acct: string, d: LocalFriendData, s: Store | null = storage()) => {
  if (!acct || !s) return;
  try {
    s.setItem(LOCAL_KEY(acct), JSON.stringify(d));
  } catch {
    /* storage full / blocked: notes are a convenience */
  }
};

/** Set (or clear, when blank) one friend's nickname or note. Trimmed and capped. */
export const withLocal = (d: LocalFriendData, field: 'nicknames' | 'notes', id: string, value: string) => {
  const next = { ...d[field] };
  const v = value.trim().slice(0, field === 'notes' ? 500 : 40);
  if (v) next[id] = v;
  else delete next[id];
  return { ...d, [field]: next };
};

/* ── Activity ────────────────────────────────────────────────────────────────────────── */

export type Recent = { input: string; label: string; avatar?: string; at: number };
export type DmInfo = { handle: string; at: number; preview: string; unread: number };
export type PaymentRow = { txid: string; time: number; amountSats: number; counterparty: string };

export type Activity = { at: number; kind: 'paid' | 'chat' | 'payment' } | null;

const norm = (s: string | null | undefined) => (s || '').trim().toLowerCase().replace(/^\$/, '');

/** Every string this contact may appear as in a recent payee, a DM or a history row. */
export const identifiersOf = (c: Contact, paymailDomain: string): Set<string> => {
  const out = new Set<string>();
  if (c.handle) {
    out.add(c.handle);
    if (paymailDomain) out.add(`${c.handle}@${paymailDomain}`);
  }
  for (const v of [c.paymail, c.address]) if (v) out.add(v.toLowerCase());
  return out;
};

export const recentFor = (c: Contact, recents: Recent[], domain: string): Recent | undefined => {
  const ids = identifiersOf(c, domain);
  return recents.filter((r) => ids.has(norm(r.input)) || ids.has(norm(r.label))).sort((a, b) => b.at - a.at)[0];
};

export const dmFor = (c: Contact, dms: DmInfo[]): DmInfo | undefined =>
  c.handle ? dms.find((d) => norm(d.handle) === c.handle) : undefined;

/** History rows whose counterparty is this friend (paymail in, or an address we know is theirs). */
export const paymentsWith = (c: Contact, rows: PaymentRow[], domain: string): PaymentRow[] => {
  const ids = identifiersOf(c, domain);
  return rows.filter((r) => r.counterparty && ids.has(r.counterparty.toLowerCase())).sort((a, b) => b.time - a.time);
};

export const lastActivity = (
  c: Contact,
  ctx: { recents: Recent[]; dms: DmInfo[]; payments: PaymentRow[]; domain: string },
): Activity => {
  const cands: NonNullable<Activity>[] = [];
  const r = recentFor(c, ctx.recents, ctx.domain);
  if (r) cands.push({ at: r.at, kind: 'paid' });
  const d = dmFor(c, ctx.dms);
  if (d?.at) cands.push({ at: d.at, kind: 'chat' });
  const p = paymentsWith(c, ctx.payments, ctx.domain)[0];
  if (p) cands.push({ at: p.time, kind: 'payment' });
  return cands.sort((a, b) => b.at - a.at)[0] ?? null;
};

export const ago = (at: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const activityLine = (a: Activity, now = Date.now()) =>
  !a ? '' : `${{ paid: 'You paid', chat: 'Chat', payment: 'Payment' }[a.kind]} ${ago(a.at, now)}`;

/* ── Friend cards ────────────────────────────────────────────────────────────────────── */

export type Friend = {
  contact: Contact;
  /** What the card shows: your nickname, else their name, masked when it reads as an email. */
  title: string;
  /** `$handle` (never a .gmail one), else ''. */
  dollar: string;
  /** `@handle` on X for a .x name, else ''. */
  social: string;
  favourite: boolean;
  activity: Activity;
};

export const buildFriends = (
  contacts: Contact[],
  ctx: {
    recents: Recent[];
    dms: DmInfo[];
    payments: PaymentRow[];
    domain: string;
    local: LocalFriendData;
    favourites: Set<string>;
  },
): Friend[] =>
  contacts.map((c) => {
    const nick = ctx.local.nicknames[c.id];
    const dollar = c.handle && !isEmailHandle(c.handle) ? `$${c.handle}` : '';
    const name = safeText(c.name) || dollar || (c.identityKey ? `${c.identityKey.slice(0, 10)}…` : 'Friend');
    return {
      contact: c,
      title: nick || name,
      dollar,
      social: socialHandle(c.handle) ?? '',
      favourite: ctx.favourites.has(c.id),
      activity: lastActivity(c, ctx),
    };
  });

export type SortBy = 'recent' | 'name';

/** Recent: last activity first (none last, by name). Name: A–Z. Favourites first in both. */
export const sortFriends = (list: Friend[], by: SortBy): Friend[] =>
  [...list].sort((a, b) => {
    if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
    if (by === 'recent') {
      const d = (b.activity?.at ?? 0) - (a.activity?.at ?? 0);
      if (d) return d;
    }
    return a.title.localeCompare(b.title);
  });

export const searchFriends = (list: Friend[], query: string): Friend[] => {
  const q = norm(query).replace(/^@/, '');
  if (!q) return list;
  return list.filter((f) =>
    [f.title, f.contact.name, f.dollar, f.social, f.contact.handle, safeText(f.contact.paymail), f.contact.address]
      .map((v) => norm(v).replace(/^@/, ''))
      .some((v) => v.includes(q)),
  );
};

/* ── Suggestions (local data only) ───────────────────────────────────────────────────── */

const ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;

export type Suggestion = { id: string; input: string; label: string; avatar?: string; why: string; at: number };

/** Recent payees and DM partners who are not friends yet and not dismissed. Newest first, at most `max`. */
export const suggestions = (
  contacts: Contact[],
  recents: Recent[],
  dms: DmInfo[],
  dismissed: string[],
  domain: string,
  max = 6,
): Suggestion[] => {
  const known = new Set<string>();
  for (const c of contacts) identifiersOf(c, domain).forEach((x) => known.add(x));
  const gone = new Set(dismissed.map(norm));
  const out = new Map<string, Suggestion>();
  const consider = (s: Suggestion) => {
    const k = norm(s.input);
    if (!k || known.has(k) || gone.has(k) || out.has(k)) return;
    // A bare address is not a person to befriend; a .gmail name would show an email.
    if (ADDRESS.test(s.input) || isEmailHandle(k) || GMAIL.test(k)) return;
    out.set(k, s);
  };
  for (const r of recents) {
    if (ADDRESS.test(r.input)) continue;
    const input = r.input.startsWith('$') || r.input.includes('@') ? r.input : r.label;
    consider({ id: norm(input), input, label: r.label, avatar: r.avatar, why: `You paid them ${ago(r.at)}`, at: r.at });
  }
  for (const d of dms) {
    const h = norm(d.handle);
    consider({ id: h, input: `$${h}`, label: `$${h}`, why: `You chatted ${ago(d.at)}`, at: d.at });
  }
  return [...out.values()].sort((a, b) => b.at - a.at).slice(0, max);
};

/* ── Add friend ──────────────────────────────────────────────────────────────────────── */

export type AddInput =
  | { kind: 'name'; query: string }
  | { kind: 'key'; key: string }
  | { kind: 'invalid'; reason: string };

/**
 * What the add box (or a scanned QR) holds: `$h`, `h`, a paymail, `@h` (X sign-in name → `$h.x`), an identity key,
 * a bWalletX person link or a `bitcoin:` request. Resolution happens in the page (names.ts resolveRecipient).
 */
export const parseAddInput = (raw: string): AddInput => {
  let s = (raw || '').trim();
  if (!s) return { kind: 'invalid', reason: 'Type a $handle, paymail, @handle or identity key' };
  const person = /^https?:\/\/(?:www\.)?bwalletx\.com\/(?:\$|u\/)([a-z0-9_.-]{1,50})\/?$/i.exec(s);
  if (person) s = `$${person[1]}`;
  const uri = /^(?:bitcoin|bsv|payto):(?:\/\/)?([^?]+)/i.exec(s);
  if (uri) s = decodeURIComponent(uri[1]);
  if (/^0[23][0-9a-f]{64}$/i.test(s)) return { kind: 'key', key: s.toLowerCase() };
  const at = /^@([a-z0-9_]{1,15})$/i.exec(s);
  if (at) return { kind: 'name', query: `$${at[1].toLowerCase()}.x` };
  if (ADDRESS.test(s))
    return { kind: 'invalid', reason: 'That is a payment address, not a person. Use their $handle or paymail.' };
  if (/^\$?[a-z0-9_.-]{1,50}$/i.test(s)) return { kind: 'name', query: s.startsWith('$') ? s : `$${s}` };
  if (/^[a-z0-9._+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return { kind: 'name', query: s.toLowerCase() };
  return { kind: 'invalid', reason: 'Type a $handle, paymail, @handle or identity key' };
};

/**
 * Collapse characters people confuse when reading a name: 0/o, 1/l/i, rn/m, vv/w, _/-/. dropped.
 * Two different names with the same skeleton are lookalikes.
 */
export const skeleton = (h: string) =>
  norm(h)
    .split('@')[0]
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1i]/g, 'l')
    .replace(/[_.-]/g, '');

export type Warning = { level: 'stop' | 'warn'; text: string };

/**
 * Before saving a friend: does this name or key collide with someone already in the list? A name that only differs
 * from an existing friend's by a lookalike swap is the classic impersonation, so it is called out by name.
 */
export const lookalikeWarnings = (
  candidate: { handle: string | null; key: string | null },
  friends: Pick<Contact, 'id' | 'name' | 'handle' | 'identityKey'>[],
  didYouMean?: string,
): Warning[] => {
  const out: Warning[] = [];
  const h = norm(candidate.handle);
  const same = candidate.key ? friends.find((f) => f.identityKey === candidate.key) : undefined;
  if (same && norm(same.handle) !== h)
    out.push({ level: 'warn', text: `This key is already your friend ${safeText(same.name)}.` });
  if (same && norm(same.handle) === h) out.push({ level: 'stop', text: 'Already in your friends.' });
  if (h) {
    const swaps = new Set(lookalikes(h));
    const sk = skeleton(h);
    for (const f of friends) {
      const fh = norm(f.handle);
      if (!fh || fh === h || (candidate.key && f.identityKey === candidate.key)) continue;
      if (swaps.has(fh) || skeleton(fh) === sk)
        out.push({
          level: 'warn',
          text: `Looks like your friend $${isEmailHandle(fh) ? maskEmail(fh) : fh}, but it is a different person.`,
        });
    }
  }
  if (didYouMean) out.push({ level: 'warn', text: `Not a bWalletX name. Did you mean ${didYouMean}?` });
  return out;
};

/* ── Messages put in a DM composer (the user still presses Send) ─────────────────────── */

/** "0.001" → "0.001", rejects anything that isn't a positive BSV amount with ≤ 8 decimals. */
export const cleanBsv = (raw: string): string | null => {
  const s = raw.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s) && !/^\.\d{1,8}$/.test(s)) return null;
  return Number(s) > 0 ? s.replace(/^\./, '0.') : null;
};

/** A payment request any wallet can scan or paste (BIP21 to my paymail). */
export const requestText = (myPaymail: string, bsv: string, note = '') => {
  const q = [`amount=${bsv}`, note.trim() ? `message=${encodeURIComponent(note.trim().slice(0, 120))}` : '']
    .filter(Boolean)
    .join('&');
  return `Payment request: ${bsv} BSV${note.trim() ? ` for ${note.trim().slice(0, 120)}` : ''}\nbitcoin:${myPaymail}?${q}`;
};

export const spaceLink = (ticker: string) => `https://bwalletx.com/s/${encodeURIComponent(ticker.toUpperCase())}`;

export const spaceInviteText = (ticker: string, title: string) => `Join me in ${title}: ${spaceLink(ticker)}`;
