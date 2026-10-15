import type { Contact } from '../chat/contacts';

/**
 * Private notes on a contact (owner, 15 Oct 2026): email, phone and free text the user typed. Only on this
 * device, per account, in localStorage. Never sent to a server and never filled in from anywhere else.
 * Not in the encrypted backup: that file is built from extension storage (MASTER_BACKUP), which has no hook
 * for page storage yet.
 */
export type ContactNotes = { email: string; phone: string; text: string };

export const EMPTY_NOTES: ContactNotes = { email: '', phone: '', text: '' };
const PREFIX = 'bwallet.abook.notes.';
const MAX = { email: 254, phone: 40, text: 4000 };

/** Who the note is about: paymail, else $handle, else identity key, else address. */
export const contactNoteKey = (c: Pick<Contact, 'paymail' | 'handle' | 'identityKey' | 'address'>): string | null => {
  const k = c.paymail?.toLowerCase() || (c.handle ? `$${c.handle.toLowerCase()}` : '') || c.identityKey || c.address;
  return k || null;
};

const storageKey = (account: string, contact: string) => `${PREFIX}${account}.${contact}`;

const fit = (n: Partial<ContactNotes>): ContactNotes => ({
  email: String(n.email ?? '').slice(0, MAX.email),
  phone: String(n.phone ?? '').slice(0, MAX.phone),
  text: String(n.text ?? '').slice(0, MAX.text),
});

export const isEmptyNotes = (n: ContactNotes) => !n.email.trim() && !n.phone.trim() && !n.text.trim();

export const loadNotes = (account: string | undefined, contact: string | null): ContactNotes => {
  if (!account || !contact) return { ...EMPTY_NOTES };
  try {
    const raw = localStorage.getItem(storageKey(account, contact));
    const j = raw ? (JSON.parse(raw) as unknown) : null;
    return j && typeof j === 'object' ? fit(j as Partial<ContactNotes>) : { ...EMPTY_NOTES };
  } catch {
    return { ...EMPTY_NOTES };
  }
};

/** Saves (or removes, when empty). Returns false when storage is unavailable. */
export const saveNotes = (account: string | undefined, contact: string | null, n: ContactNotes): boolean => {
  if (!account || !contact) return false;
  try {
    const v = fit(n);
    if (isEmptyNotes(v)) localStorage.removeItem(storageKey(account, contact));
    else localStorage.setItem(storageKey(account, contact), JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};
