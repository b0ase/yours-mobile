import type { Contact } from '../chat/contacts';
import { saveTextFile } from '../agents/saveText';
import { contactNoteKey, loadNotes } from './contactNotes';
import { toCsv } from './abookParse';

/** Export the user's own address book as CSV (names, paymails, handles, keys, private notes). */
export const exportAddressBook = async (contacts: Contact[], account: string | undefined) => {
  const rows = contacts.map((c) => {
    const n = loadNotes(account, contactNoteKey(c));
    return {
      name: c.name,
      paymail: c.paymail ?? '',
      handle: c.handle ? `$${c.handle}` : '',
      identityKey: c.identityKey ?? '',
      notes: [n.email, n.phone, n.text].filter((s) => s.trim()).join(' · '),
    };
  });
  await saveTextFile(`bwalletx-address-book-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv');
};
