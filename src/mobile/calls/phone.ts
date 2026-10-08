import type { ServerCall } from './machine';
import { filterContacts, type Contact } from '../chat/contacts';
import type { PeerBPhone } from './bphone';
import type { Category } from './rateCard';

/**
 * Chat › Calls as a phone. A yellow bPhone card (my rate) and one search box on top; a bottom tab
 * bar: Recents | Contacts (Favourites starred at the top) | Services | Keypad. Pure helpers + small
 * local stores. Recents are bit-sign's call records (GET /api/bitsign/wallet-calls); bit-sign has
 * no delete, so "Delete" hides a record on this device only. Favourites are local per device.
 * Voicemail: not built (no server mailbox).
 */

export type PhoneTab = 'recents' | 'contacts' | 'services' | 'keypad';
const RECENTS = { id: 'recents' as const, label: 'Recents' };
const CONTACTS = { id: 'contacts' as const, label: 'Contacts' };
const SERVICES = { id: 'services' as const, label: 'Services' };
const KEYPAD = { id: 'keypad' as const, label: 'Keypad' };
/** Store build: plain calls only (no Services, no prices). Keypad always last (the green button). */
export const phoneTabsFor = (paidCalls: boolean): { id: PhoneTab; label: string }[] =>
  paidCalls ? [RECENTS, CONTACTS, SERVICES, KEYPAD] : [RECENTS, CONTACTS, KEYPAD];
/** A tab the build can show; anything else falls back to Recents. */
export const allowedTab = (tab: string, paidCalls: boolean): PhoneTab =>
  phoneTabsFor(paidCalls).find((t) => t.id === tab)?.id ?? 'recents';

export const isMissed = (c: ServerCall) =>
  c.direction === 'incoming' && !c.answered_at && c.status !== 'ringing' && c.status !== 'active';

/** Recents' filter menu. Blocked shows the block list, not calls. */
export type RecentsFilter = 'all' | 'missed' | 'blocked';
export const RECENTS_FILTERS: { id: RecentsFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'missed', label: 'Missed' },
  { id: 'blocked', label: 'Blocked' },
];

export const visibleRecents = (calls: ServerCall[], filter: RecentsFilter, hidden: ReadonlySet<string>) =>
  filter === 'blocked' ? [] : calls.filter((c) => !hidden.has(c.id) && (filter === 'all' || isMissed(c)));

// ── Services (bPhone directory) ──

export type ServiceChip = 'all' | 'legal' | 'health' | 'money' | 'tech' | 'coaching' | 'creative' | 'other';
/** Chips onto the listing's stored category (rateCard.CATEGORIES); no new categories needed. */
export const SERVICE_CHIPS: { id: ServiceChip; label: string; cats: Category[] }[] = [
  { id: 'all', label: 'All', cats: [] },
  { id: 'legal', label: 'Legal', cats: ['legal'] },
  { id: 'health', label: 'Health & therapy', cats: ['therapy', 'medical'] },
  { id: 'money', label: 'Money & tax', cats: ['finance'] },
  { id: 'tech', label: 'Tech', cats: ['tech'] },
  { id: 'coaching', label: 'Coaching', cats: ['coaching'] },
  { id: 'creative', label: 'Creative', cats: ['creative'] },
  { id: 'other', label: 'Other', cats: ['other'] },
];
export const servicesIn = (list: PeerBPhone[], chip: ServiceChip): PeerBPhone[] => {
  const cats = SERVICE_CHIPS.find((c) => c.id === chip)?.cats ?? [];
  return cats.length ? list.filter((p) => cats.includes(p.profile.listing.category)) : list;
};
export const chipOf = (c: Category): ServiceChip => SERVICE_CHIPS.find((x) => x.cats.includes(c))?.id ?? 'other';

// ── one search box: people, recents, services ──

export interface SearchGroups {
  people: Contact[];
  recents: ServerCall[];
  services: PeerBPhone[];
}
export const searchEmpty = (g: SearchGroups) => !g.people.length && !g.recents.length && !g.services.length;

/**
 * "Search people and services". People: contacts (name, handle, paymail). Recents: the latest call
 * per person whose shown name matches, skipping anyone already under People. Services: listings by
 * title, name, paymail, about or category.
 */
export const searchCalls = (
  query: string,
  src: { contacts: Contact[]; recents: ServerCall[]; services: PeerBPhone[]; nameOf: (c: ServerCall) => string },
  max = 5,
): SearchGroups => {
  const q = query.trim().toLowerCase().replace(/^[$@]/, '');
  if (!q) return { people: [], recents: [], services: [] };
  const has = (...v: (string | null | undefined)[]) => v.some((x) => (x ?? '').toLowerCase().includes(q));
  const people = filterContacts(src.contacts, q).slice(0, max);
  const peopleKeys = new Set(people.map((c) => c.identityKey).filter(Boolean));
  const seen = new Set<string>();
  const recents: ServerCall[] = [];
  for (const c of src.recents) {
    if (recents.length >= max || seen.has(c.peer_key) || peopleKeys.has(c.peer_key)) continue;
    if (!has(src.nameOf(c), c.peer_label)) continue;
    seen.add(c.peer_key);
    recents.push(c);
  }
  const services = src.services
    .filter((p) => {
      const l = p.profile.listing;
      const chip = SERVICE_CHIPS.find((x) => x.id === chipOf(l.category))?.label;
      return has(l.title, p.name, p.paymail, l.about, chip);
    })
    .slice(0, max);
  return { people, recents, services };
};

/** A pinned person: enough to call or message without the source lists loaded. */
export interface Favourite {
  id: string;
  name: string;
  identityKey: string | null;
  handle: string | null;
  avatar: string | null;
}

export const asFavourite = (c: Contact): Favourite => ({
  id: c.id,
  name: c.name,
  identityKey: c.identityKey,
  handle: c.handle,
  avatar: c.avatar,
});

export const isFavourite = (favs: Favourite[], id: string) => favs.some((f) => f.id === id);

export const toggleFavourite = (favs: Favourite[], f: Favourite): Favourite[] =>
  isFavourite(favs, f.id) ? favs.filter((x) => x.id !== f.id) : [...favs, f];

export type DialTarget =
  | { kind: 'empty' }
  | { kind: 'number'; reason: string }
  /** Resolve with peer.ts (paymail pki / OpNS idKey / $handle). */
  | { kind: 'name'; raw: string };

/** Keypad input: `@123` is a numbered account (not live yet); anything else is a name to resolve. */
export const parseDial = (raw: string): DialTarget => {
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  if (/^@\d+$/.test(s))
    return { kind: 'number', reason: 'Numbered accounts aren’t live yet — call a $handle or paymail' };
  return { kind: 'name', raw: s };
};

/** Callable contacts matching what's typed, best first (name starts-with before contains). */
export const dialSuggestions = (contacts: Contact[], query: string, max = 6): Contact[] => {
  const q = query.trim().toLowerCase().replace(/^[$@]/, '');
  if (!q) return [];
  const hits = filterContacts(
    contacts.filter((c) => !!c.identityKey),
    q,
  );
  const starts = (c: Contact) =>
    c.name.toLowerCase().replace(/^\$/, '').startsWith(q) || (c.handle ?? '').startsWith(q) ? 0 : 1;
  return [...hits].sort((a, b) => starts(a) - starts(b)).slice(0, max);
};

// ── local stores (per wallet identity) ──

const read = <T>(key: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const favKey = (owner: string) => `bwallet.calls.favourites.${owner}`;
const hiddenKey = (owner: string) => `bwallet.calls.hiddenRecents.${owner}`;

export const loadFavourites = (owner: string): Favourite[] =>
  read<Favourite[]>(favKey(owner), []).filter((f) => f && typeof f.id === 'string');
export const saveFavourites = (owner: string, favs: Favourite[]) => write(favKey(owner), favs);
export const loadHidden = (owner: string): Set<string> => new Set(read<string[]>(hiddenKey(owner), []));
export const saveHidden = (owner: string, ids: Set<string>) => write(hiddenKey(owner), [...ids].slice(-500));
