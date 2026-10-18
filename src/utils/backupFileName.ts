/**
 * Every downloaded wallet/account backup is named for its account (owner, 18 Oct 2026):
 * `bwalletx-backup-<account-name-slug>-YYYY-MM-DD.<ext>`. Only the account's name goes in, never a key,
 * address or phrase.
 */

/** ASCII, lowercase, hyphens only, at most 40 characters; 'account' when nothing usable is left. */
export const accountSlug = (name: string | undefined | null): string => {
  const slug = (name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'account';
};

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const backupFileName = (accountName: string | undefined | null, ext: string, now = new Date()): string =>
  `bwalletx-backup-${accountSlug(accountName)}-${localDate(now)}.${ext.replace(/^\./, '')}`;
