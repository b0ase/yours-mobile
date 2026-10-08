import type { ServerCall } from './machine';
import { filterContacts, type Contact } from '../chat/contacts';

/**
 * Chat › Calls as a phone: Favourites | Recents | Contacts | Dial. Pure helpers + small local
 * stores. Recents are bit-sign's call records (GET /api/bitsign/wallet-calls); bit-sign has no
 * delete, so "Delete" hides a record on this device only. Favourites are local per device.
 * Voicemail: not built (no server mailbox).
 */

export type PhoneTab = 'favourites' | 'recents' | 'contacts' | 'dial' | 'experts' | 'bphone';
export const PHONE_TABS: { id: PhoneTab; label: string }[] = [
  { id: 'favourites', label: 'Favourites' },
  { id: 'recents', label: 'Recents' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'dial', label: 'Dial' },
];
/** bPhone (rateCard.ts): the directory of people who charge for calls, and my own price. bWalletX only. */
export const BPHONE_TABS: { id: PhoneTab; label: string }[] = [
  { id: 'experts', label: 'Experts' },
  { id: 'bphone', label: 'bPhone' },
];
export const phoneTabsFor = (paidCalls: boolean) => (paidCalls ? [...PHONE_TABS, ...BPHONE_TABS] : PHONE_TABS);

export const isMissed = (c: ServerCall) =>
  c.direction === 'incoming' && !c.answered_at && c.status !== 'ringing' && c.status !== 'active';

export type RecentsFilter = 'all' | 'missed';

export const visibleRecents = (calls: ServerCall[], filter: RecentsFilter, hidden: ReadonlySet<string>) =>
  calls.filter((c) => !hidden.has(c.id) && (filter === 'all' || isMissed(c)));

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
