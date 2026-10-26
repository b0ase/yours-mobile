import { PAYMAIL_ALIAS_RE, toAlias } from '../names/paymail';

/**
 * "Choose your handle" from ALL linked accounts, one primary (owner, 26 Oct 2026). It used to offer one source (the X
 * @name) and ignore a Google account linked just before. Now each linked account suggests its own $name:
 *   X @name · Google email local part (rboase2020@gmail.com → rboase2020) · GitHub login · LinkedIn name · HandCash $handle.
 * The user may claim several (each is its own paymail on the same key) and must pick exactly one primary, which becomes
 * the main paymail / account name. Only accounts the user linked are used: nothing is derived from any other email.
 * The Google local part is the one exception to "never anything from an email" (owner's call, 26 Oct 2026): it is kept
 * on this device only, while the claim is pending, and is never put into a link badge (links.ts still stores no email).
 * Pure helpers + a small localStorage stash; nothing here claims, signs or pays.
 */

export type HandleSource = 'x' | 'google' | 'github' | 'linkedin' | 'handcash';
export const SOURCE_ORDER: HandleSource[] = ['x', 'google', 'github', 'linkedin', 'handcash'];
export const SOURCE_LABEL: Record<HandleSource, string> = {
  x: 'X',
  google: 'Google',
  github: 'GitHub',
  linkedin: 'LinkedIn',
  handcash: 'HandCash',
};

/** The plain $name a linked account suggests ('' when it gives none that is a valid paymail alias). */
export const handleFromLinked = (source: HandleSource, raw: string | null | undefined): string => {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (source === 'google') {
    // Only an address: its local part. Gmail ignores dots, and paymail aliases have none, so they are dropped.
    const at = s.lastIndexOf('@');
    if (at <= 0) return '';
    s = s.slice(0, at);
  } else {
    if (source !== 'linkedin' && s.includes('@', 1)) return ''; // an email in a handle field: never used
    s = s.replace(/^[@$]/, '');
  }
  const a = toAlias(s);
  return PAYMAIL_ALIAS_RE.test(a) ? a : '';
};

export type HandleSuggestion = { source: HandleSource; alias: string };

/** One suggestion per linked account, in SOURCE_ORDER, without duplicates (the first source keeps a shared name). */
export const linkedSuggestions = (found: Partial<Record<HandleSource, string>>): HandleSuggestion[] => {
  const seen = new Set<string>();
  const out: HandleSuggestion[] = [];
  for (const source of SOURCE_ORDER) {
    const alias = found[source] ? toAlias(found[source] as string) : '';
    if (!alias || !PAYMAIL_ALIAS_RE.test(alias) || seen.has(alias)) continue;
    seen.add(alias);
    out.push({ source, alias });
  }
  return out;
};

/**
 * The primary after a change to the selection: kept while still selected, the only name when one is selected,
 * else none ('' = the user must pick one before continuing).
 */
export const resolvePrimary = (selected: readonly string[], primary: string): string => {
  if (primary && selected.includes(primary)) return primary;
  return selected.length === 1 ? selected[0] : '';
};

/** Continue needs at least one name and exactly one primary among them. */
export const canClaimSelection = (selected: readonly string[], primary: string) =>
  selected.length > 0 && !!primary && selected.includes(primary);

/**
 * Claim order: the primary first (the first claim on a wallet becomes its main paymail), then the others as extra
 * names in the order shown. Duplicates dropped.
 */
export const claimOrder = (selected: readonly string[], primary: string): string[] =>
  canClaimSelection(selected, primary) ? [primary, ...[...new Set(selected)].filter((a) => a !== primary)] : [];

// ── Stash: what each account suggested when it was linked (Google's local part is not kept anywhere else). ──
const KEY = (owner: string) => `bwallet.linkedHandles.${owner}`;
export const LINKED_HANDLE_TTL_MS = 24 * 60 * 60_000;
type Stash = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Entry = { alias: string; at: number };
const store = (): Stash | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const readMap = (owner: string, s: Stash | null): Partial<Record<HandleSource, Entry>> => {
  try {
    const v = JSON.parse(s?.getItem(KEY(owner)) || '{}') as Partial<Record<HandleSource, Entry>>;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const writeMap = (owner: string, m: Partial<Record<HandleSource, Entry>>, s: Stash | null) => {
  try {
    if (Object.keys(m).length) s?.setItem(KEY(owner), JSON.stringify(m));
    else s?.removeItem(KEY(owner));
  } catch {
    /* private mode */
  }
};

export const rememberLinkedHandle = (
  owner: string,
  source: HandleSource,
  raw: string | null | undefined,
  now = Date.now(),
  s: Stash | null = store(),
) => {
  const alias = handleFromLinked(source, raw);
  if (!owner || !alias) return;
  writeMap(owner, { ...readMap(owner, s), [source]: { alias, at: now } }, s);
};

export const rememberedLinkedHandles = (
  owner: string,
  now = Date.now(),
  s: Stash | null = store(),
): Partial<Record<HandleSource, string>> => {
  if (!owner) return {};
  const m = readMap(owner, s);
  const out: Partial<Record<HandleSource, string>> = {};
  const keep: Partial<Record<HandleSource, Entry>> = {};
  for (const src of SOURCE_ORDER) {
    const e = m[src];
    if (e?.alias && typeof e.at === 'number' && now - e.at < LINKED_HANDLE_TTL_MS && PAYMAIL_ALIAS_RE.test(e.alias)) {
      out[src] = e.alias;
      keep[src] = e;
    }
  }
  if (Object.keys(keep).length !== Object.keys(m).length) writeMap(owner, keep, s);
  return out;
};

export const forgetLinkedHandle = (owner: string, source: HandleSource, s: Stash | null = store()) => {
  const m = readMap(owner, s);
  delete m[source];
  writeMap(owner, m, s);
};
export const forgetLinkedHandles = (owner: string, s: Stash | null = store()) => writeMap(owner, {}, s);

/** Create Account links under NEW_ACCOUNT ('new'); once the account exists its suggestions move to it. */
export const bindLinkedHandles = (from: string, to: string, s: Stash | null = store()) => {
  if (!from || !to || from === to) return;
  const m = readMap(from, s);
  if (!Object.keys(m).length) return;
  writeMap(to, { ...readMap(to, s), ...m }, s);
  writeMap(from, {}, s);
};
