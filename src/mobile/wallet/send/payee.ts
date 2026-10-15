import { OPNS_PROFILE_DOMAIN } from '../../names/config';
import { isOurDomain } from '../../names/names';
import { keyFingerprint } from '../identityLine';

/**
 * Payee safety at payment time (owner, 15 Oct 2026). Names stay open to "hacker spellings" (b0ase and
 * boase are different people), so nothing is blocked at registration. Instead the confirm sheet says
 * when this wallet has never paid a paymail before, and warns when a name has the same "shape" as a
 * DIFFERENT name this wallet has paid or saved as a contact. Pure helpers plus a small local store.
 */

/** A paymail this wallet knows: paid before or saved as a contact. */
export type KnownPayee = { paymail: string; label: string; avatar?: string };

/** Lowercase name@domain; any bWalletX domain counts as one. '' when `target` isn't a paymail. */
export const canonPaymail = (target: string): string => {
  const t = (target || '').trim().toLowerCase().replace(/^\$/, '');
  const m = t.match(/^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return '';
  return `${m[1]}@${isOurDomain(m[2]) || m[2] === OPNS_PROFILE_DOMAIN ? OPNS_PROFILE_DOMAIN : m[2]}`;
};

const CHAR: Record<string, string> = { '0': 'o', '1': 'l', i: 'l', '5': 's', '2': 'z', '8': 'b', '9': 'g', q: 'g' };

/**
 * A name reduced to how it looks: lowercase; strip $, the @domain and - _ .; rn→m, vv→w;
 * 0/o, 1/l/i, 5/s, 2/z, 8/b, 9/g/q. "b0ase", "boase" and "B0-ASE" all give "boase".
 */
export const shape = (name: string): string => {
  const local = (name || '').trim().toLowerCase().replace(/^\$/, '').split('@')[0];
  return local
    .replace(/[-_.]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/./g, (c) => CHAR[c] ?? c);
};

/**
 * The known payee that LOOKS like `target` but is a different paymail, or null. An exact match of a
 * known payee is trusted (null), and so is a target that isn't a paymail.
 */
export const lookalikeOf = (target: string, known: KnownPayee[]): KnownPayee | null => {
  const t = canonPaymail(target);
  if (!t) return null;
  if (known.some((k) => canonPaymail(k.paymail) === t)) return null;
  const s = shape(t);
  if (!s) return null;
  return known.find((k) => canonPaymail(k.paymail) && shape(k.paymail) === s) ?? null;
};

/* ── Paid-before store (per account, updated only after a successful send) ─────────────── */

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = (acct: string) => `bwallet.send.paid.${acct}`;
export const MAX_PAID = 500;

const storage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export type PaidPayee = KnownPayee & { at: number };

export const loadPaid = (acct: string, s: Store | null = storage()): PaidPayee[] => {
  if (!acct || !s) return [];
  try {
    const v = JSON.parse(s.getItem(KEY(acct)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.paymail === 'string' && typeof x.label === 'string') : [];
  } catch {
    return [];
  }
};

/** Remember paid paymails (addresses are ignored), newest first, one row per paymail. */
export const recordPaid = (acct: string, add: KnownPayee[], now = Date.now(), s: Store | null = storage()) => {
  if (!acct || !s) return;
  const rows = add.filter((a) => canonPaymail(a.paymail)).map((a) => ({ ...a, at: now }));
  if (!rows.length) return;
  const seen = new Set<string>();
  const out: PaidPayee[] = [];
  for (const r of [...rows, ...loadPaid(acct, s)]) {
    const k = canonPaymail(r.paymail);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  try {
    s.setItem(KEY(acct), JSON.stringify(out.slice(0, MAX_PAID)));
  } catch {
    /* storage full / blocked: the warning just has less to compare against */
  }
};

export const hasPaid = (acct: string, target: string, s: Store | null = storage()): boolean => {
  const t = canonPaymail(target);
  return !!t && loadPaid(acct, s).some((p) => canonPaymail(p.paymail) === t);
};

// Contacts the Send card already loaded (useContacts), so the confirm sheet can compare against them.
let contactPayees: KnownPayee[] = [];
export const noteContacts = (list: KnownPayee[]) => {
  contactPayees = list.filter((c) => canonPaymail(c.paymail));
};

/** What the confirm sheet shows under a recipient. */
export type PayeeNote = {
  name?: string;
  avatar?: string;
  /** Identity key fingerprint (abc123…wxyz), once PKI resolved it. */
  fingerprint?: string;
  /** This wallet has never paid this paymail. */
  firstTime?: boolean;
  /** A different, known name with the same shape. */
  lookalike?: { name: string; avatar?: string };
};

export const payeeNote = (
  acct: string,
  target: string,
  meta: { label?: string; avatar?: string; pubkey?: string } | undefined,
  s: Store | null = storage(),
  contacts: KnownPayee[] = contactPayees,
): PayeeNote | undefined => {
  const isPaymail = !!canonPaymail(target);
  const fingerprint = keyFingerprint(meta?.pubkey) || undefined;
  if (!isPaymail && !meta) return undefined;
  const paid = loadPaid(acct, s);
  const look = isPaymail ? lookalikeOf(target, [...paid, ...contacts]) : null;
  return {
    name: meta?.label,
    avatar: meta?.avatar,
    fingerprint,
    firstTime: isPaymail && !paid.some((p) => canonPaymail(p.paymail) === canonPaymail(target)),
    lookalike: look ? { name: look.label || look.paymail, avatar: look.avatar } : undefined,
  };
};
