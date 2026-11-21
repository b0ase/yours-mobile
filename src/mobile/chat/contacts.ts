import { dmPeer, isDirectRoom, normHandle, roomActivity, type ChatRoom } from './messages';

/**
 * DMs + Contacts (owner: "private messages and friends and contact lists are all the same
 * thing"). One person = one Contact, merged from every source we can read; a DM is bit-sign's
 * 1:1 room (POST /api/bitsign/rooms/direct — find-or-create, membership exactly the two of us).
 *
 * ⚠ ACCOUNT TRANSFER HOOK (numbered-accounts spec): DMs and any E2E keys are DELETED when an
 * account is transferred, after offering an export. The hook belongs here: whatever performs the
 * transfer must (1) offer an export of `dmRooms(rooms)` conversations, (2) leave/delete those
 * rooms server-side and (3) clear the local DM/contacts caches (`bwallet.bchat.*`,
 * `bwallet.calls.friends.*`). No transfer logic exists yet; nothing here does it.
 */

export type ContactSource = 'bchat' | 'friend' | 'follow' | 'twetch' | 'handcash';

export const SOURCE_LABEL: Record<ContactSource, string> = {
  bchat: 'bChat',
  friend: 'Friend',
  follow: 'Following',
  twetch: 'Twetch',
  handcash: 'HandCash',
};

export interface Contact {
  id: string;
  name: string;
  /** bChat (bit-sign) handle, bare + lowercased — what a DM needs. */
  handle: string | null;
  paymail: string | null;
  /** Identity public key (hex) — what a call needs. */
  identityKey: string | null;
  /** A BSV address (from a Feed follow) — payable, nothing else. */
  address: string | null;
  avatar: string | null;
  /** bit-sign contact row id (for removal). */
  bchatId: string | null;
  sources: ContactSource[];
}

/** GET /api/bitsign/me/contacts row. */
export interface BchatContact {
  id: string;
  handle: string | null;
  email: string | null;
  name: string | null;
}
export interface FriendLike {
  key: string;
  name: string;
  avatar: string | null;
}
export interface FollowLike {
  bapId: string | null;
  address: string;
  name: string;
}

/** `$x`, `x@bwallet.space` (the bChat handle IS the paymail name) → `x`. */
export const handleFromLabel = (label: string | null | undefined): string | null => {
  const s = (label || '').trim().toLowerCase();
  const h = s.match(/^\$([a-z0-9_.-]{1,50})$/);
  if (h) return h[1];
  const p = s.match(/^([a-z0-9_.-]{1,64})@(?:bwalletx\.com|bwallet\.space)$/);
  return p ? p[1] : null;
};

const paymailOf = (label: string | null | undefined): string | null => {
  const s = (label || '').trim().toLowerCase();
  return /^[a-z0-9._+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
};

/**
 * A friend's label proven for its key: resolving `label` (pki / binding) gave exactly `key` (useProvenLabels).
 * Only then does a friend's "$alice" / "alice@…" become its handle or paymail (b-Aware row 351).
 */
export const provenLabel = (label: string, key: string): string => `${label.trim().toLowerCase()}|${key.toLowerCase()}`;

/** A label that reads like a $handle or a paymail: shown with "(not verified)" unless it was proven. */
export const looksLikeName = (label: string | null | undefined): boolean =>
  handleFromLabel(label) !== null || paymailOf(label) !== null;

/**
 * The friends whose "$name" / paymail label resolves (via `keyOf`, the Calls resolver) to that friend's own key.
 * A failure or another key leaves the label unproven.
 */
export const proveLabels = async (
  friends: readonly FriendLike[],
  keyOf: (label: string) => Promise<string>,
): Promise<Set<string>> => {
  const out = new Set<string>();
  await Promise.all(
    friends
      .filter((f) => looksLikeName(f.name))
      .map(async (f) => {
        try {
          if ((await keyOf(f.name.trim())).toLowerCase() === f.key.toLowerCase()) out.add(provenLabel(f.name, f.key));
        } catch {
          /* unproven */
        }
      }),
  );
  return out;
};

export const UNVERIFIED_SUFFIX = ' (not verified)';
const unproven = (label: string) => (looksLikeName(label) ? `${label.trim()}${UNVERIFIED_SUFFIX}` : label.trim());

const blank = (id: string, name: string): Contact => ({
  id,
  name,
  handle: null,
  paymail: null,
  identityKey: null,
  address: null,
  avatar: null,
  bchatId: null,
  sources: [],
});

/**
 * Merge every source into one list. Two entries are the same person when they share a bChat
 * handle, an identity key or an address. Named sources beat derived names; sorted by name.
 */
export const mergeContacts = (
  bchat: BchatContact[],
  friends: FriendLike[],
  follows: FollowLike[],
  me?: string | null,
  proven: ReadonlySet<string> = new Set(),
): Contact[] => {
  const out: Contact[] = [];
  const find = (c: Partial<Contact>) =>
    out.find(
      (x) =>
        (!!c.handle && x.handle === c.handle) ||
        (!!c.identityKey && x.identityKey === c.identityKey) ||
        (!!c.address && x.address === c.address),
    );
  const add = (src: ContactSource, c: Partial<Contact> & { name: string }) => {
    if (me && c.handle && c.handle === normHandle(me)) return;
    let x = find(c);
    if (!x) {
      x = blank(c.handle ? `h:${c.handle}` : c.identityKey ? `k:${c.identityKey}` : `a:${c.address}`, c.name);
      out.push(x);
    }
    x.handle ??= c.handle ?? null;
    x.paymail ??= c.paymail ?? null;
    x.identityKey ??= c.identityKey ?? null;
    x.address ??= c.address ?? null;
    x.avatar ??= c.avatar ?? null;
    x.bchatId ??= c.bchatId ?? null;
    if (!x.name || /^\$/.test(x.name)) x.name = c.name || x.name;
    if (!x.sources.includes(src)) x.sources.push(src);
  };
  for (const b of bchat) {
    const handle = b.handle ? normHandle(b.handle) : null;
    if (!handle) continue; // email-only rows can't be messaged from the wallet
    add('bchat', { handle, name: b.name?.trim() || `$${handle}`, bchatId: b.id });
  }
  // A friend's or follow's name is what someone typed or chose for themselves. It only becomes a handle or paymail
  // (which joins it to that person and pays them) when resolving it gave this friend's key (b-Aware row 351).
  for (const f of friends) {
    const key = f.key.toLowerCase();
    const ok = proven.has(provenLabel(f.name, key));
    add('friend', {
      identityKey: key,
      handle: ok ? handleFromLabel(f.name) : null,
      paymail: ok ? paymailOf(f.name) : null,
      name: (ok ? f.name.trim() : unproven(f.name)) || key.slice(0, 10),
      avatar: f.avatar,
    });
  }
  // A Feed follow is only an address and a self-chosen name: never a handle.
  for (const f of follows) {
    if (!f.address) continue;
    add('follow', {
      address: f.address,
      handle: null,
      name: unproven(f.name) || f.address.slice(0, 10),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

export const contactLine = (c: Contact) =>
  c.handle
    ? `$${c.handle}`
    : c.paymail
      ? c.paymail
      : c.identityKey
        ? `${c.identityKey.slice(0, 10)}…`
        : (c.address ?? '');

export const canMessage = (c: Contact) => !!c.handle;
export const canCall = (c: Contact) => !!c.identityKey;
/**
 * Where Pay sends: a paymail or address we were actually given. Never derived from a bChat
 * handle — `$alice` on bChat need not own alice@bwallet.space, and money must not guess.
 */
export const payTarget = (c: Contact): string | null => c.paymail ?? c.address;

export const filterContacts = (list: Contact[], query: string) => {
  const q = query.trim().toLowerCase().replace(/^\$/, '');
  if (!q) return list;
  return list.filter((c) => [c.name, c.handle, c.paymail, c.address].some((v) => (v || '').toLowerCase().includes(q)));
};

// ── DMs ──

/** 1:1 rooms, newest first. Prefers bit-sign's `list_kind` ('message'); older servers: the name. */
export const dmRooms = (rooms: ChatRoom[]): ChatRoom[] =>
  rooms
    .filter((r) => {
      if (r.metadata && (r.metadata as { tokenGate?: unknown }).tokenGate) return false;
      if (r.list_kind) return r.list_kind === 'message' && (r.party_count ?? 2) <= 2;
      return isDirectRoom(r);
    })
    .sort((a, b) => roomActivity(b) - roomActivity(a));

/** b's handle: your own 1:1 with b is pinned at the top of DMs (bit-sign lib/b-direct-rules.ts). */
export const B_HANDLE = 'b';

/** The viewer's 1:1 with b among their DM rooms ("$me ↔ $b"), or null when it hasn't been opened yet. */
export const bDirectOf = (rooms: ChatRoom[], me: string): ChatRoom | null =>
  rooms.find((r) => (dmPeer(r, me) || '').toLowerCase() === B_HANDLE) ?? null;

export const unreadTotal = (rooms: ChatRoom[]) => rooms.reduce((n, r) => n + (r.unread ?? 0), 0);

export type DmTarget = { kind: 'handle'; handle: string } | { kind: 'invalid'; reason: string };

/**
 * "New message to…": `$name`, `name`, or `name@bwallet.space` → a bChat handle. Other
 * paymails (HandCash, RelayX…) and OpNS names resolve to an identity key, and bit-sign has no
 * key → handle lookup yet, so those are refused with a clear reason.
 */
export const parseDmTarget = (raw: string): DmTarget => {
  const s = raw.trim().toLowerCase();
  if (!s) return { kind: 'invalid', reason: 'Type a $handle or name@bwalletx.com' };
  const h = handleFromLabel(s) ?? (/^[a-z0-9_.-]{1,50}$/.test(s) ? s : null);
  if (h) return { kind: 'handle', handle: h };
  if (s.includes('@')) return { kind: 'invalid', reason: 'Only bWallet / bChat names can be messaged for now' };
  return { kind: 'invalid', reason: 'Not a handle' };
};
