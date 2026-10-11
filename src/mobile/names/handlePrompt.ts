/**
 * "Choose your handle" prompts: the onboarding step after create / restore, and the dismissible
 * "Get your $name" card on the Wallet tab. Pure decisions + localStorage flags; nothing here
 * signs, claims or broadcasts (claims go through paymail.ts / GetYourName).
 */
import { PAYMAIL_ALIAS_RE, toAlias } from './paymail';
import { markBackupPrompt, markCreatedHere, markImported } from '../backup/backupState';

export type PromptReason = 'create' | 'restore';
export type PendingPrompt = { id: string; reason: PromptReason };

const PENDING = 'bwallet.handlePrompt.pending';
const DISMISSED = (id: string) => `bwallet.handlePrompt.dismissed.${id}`;
const EVENT = 'bwallet-handle-prompt';

const store = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const fire = () => {
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const parsePending = (raw: string | null | undefined): PendingPrompt | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingPrompt>;
    if (typeof v?.id !== 'string' || !v.id) return null;
    if (v.reason !== 'create' && v.reason !== 'restore') return null;
    return { id: v.id, reason: v.reason };
  } catch {
    return null;
  }
};

/** Called by the create / restore flows (build-time insert) once the new account is stored. */
export const markHandlePrompt = (id: string | undefined, reason: PromptReason) => {
  if (!id) return;
  store()?.setItem(PENDING, JSON.stringify({ id, reason }));
  // Every create / restore path calls this. A new wallet gets the "Back up your wallet" step; a restored one is
  // already backed up (the user typed in or loaded its phrase, key or file).
  if (reason === 'restore') markImported(id);
  else {
    markBackupPrompt(id);
    markCreatedHere(id);
  }
  fire();
};
export const getPendingPrompt = (): PendingPrompt | null => parsePending(store()?.getItem(PENDING));
export const clearPendingPrompt = () => {
  store()?.removeItem(PENDING);
  fire();
};

export const isCardDismissed = (id?: string) => !!id && store()?.getItem(DISMISSED(id)) === '1';
export const dismissCard = (id: string) => {
  store()?.setItem(DISMISSED(id), '1');
  fire();
};
export const onHandlePromptChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/**
 * Show the onboarding step for this account? Only for the account the flag was set for, and
 * never when it already has a name. A restore waits for the name sync first (`synced`), so a
 * restored wallet that already owns a paymail / OpNS name is not asked again.
 */
export const shouldShowOnboarding = (
  pending: PendingPrompt | null,
  current: string | undefined,
  hasName: boolean,
  synced: boolean,
): boolean => {
  if (!pending || !current || pending.id !== current || hasName) return false;
  return pending.reason === 'create' || synced;
};

/** Every account gets a handle AND its personal $NAME room; the prompts stay until both exist. */
export const handleComplete = (hasName: boolean, hasRoom: boolean) => hasName && hasRoom;

/** The Wallet card: until the account has a handle and a room, unless dismissed or the sheet is up. */
export const shouldShowCard = (complete: boolean, dismissed: boolean, onboardingOpen: boolean) =>
  !complete && !dismissed && !onboardingOpen;

/** A default name nobody chose ("Anonymous", "Account 1", the app name): never shown as a person's name. */
export const isPlaceholderName = (n = '') =>
  !n.trim() || /^(account\s*\d*|anonymous|anon|bwallet|bwalletx|yours|wallet)$/i.test(n.trim());

/** First suggestion for the handle input: the profile name, else the account name ("Account 1" → ''). */
export const suggestHandle = (profileName = '', accountName = ''): string => {
  for (const n of [profileName, accountName]) {
    // Placeholders are never offered as a handle ("Account 1", the default "Anonymous", the app name).
    if (isPlaceholderName(n)) continue;
    const a = toAlias(n);
    if (a) return a;
  }
  return '';
};

/** "$alice" for the card title, else "$name". */
export const handleTitle = (alias: string) => `$${alias || 'name'}`;

/**
 * Does this account already have its handle? The paymail server's lookup (by identity key) is the
 * authoritative answer; the local cache only paints until it answers. `lookup` is undefined while the
 * lookup has not answered (still loading, or it failed): never 'none' then, so a wallet that owns a name
 * is not asked to register one again (owner, 11 Oct 2026: $b0asex was offered for registration).
 */
export type HandleState = 'loading' | 'has' | 'none';
export const handleState = (cached: string, lookup: readonly { paymail: string }[] | undefined): HandleState => {
  if (cached) return 'has';
  if (lookup === undefined) return 'loading';
  return lookup.length ? 'has' : 'none';
};

/**
 * The plain handle to sign in to bChatX with: the main plain paymail, else any plain one, else the cached
 * paymail's name. A verified .x / .gmail name is never a handle (a .gmail one would publish the address).
 */
export const pickHandleAlias = (
  names: readonly { paymail: string; kind?: string; main?: boolean }[],
  cached = '',
): string | null => {
  const alias = (p: string) => p.split('@')[0] ?? '';
  const ok = (a: string) => PAYMAIL_ALIAS_RE.test(a);
  const plain = names.filter((n) => (n.kind ?? 'plain') === 'plain' && ok(alias(n.paymail)));
  const pick = plain.find((n) => n.main) ?? plain[0];
  if (pick) return alias(pick.paymail);
  return ok(alias(cached)) ? alias(cached) : null;
};

/** Where closing Connect X / Google goes: back to Settings when opened from there, else the Wallet home. */
export const socialCloseTarget = (openedByReturn: boolean): 'settings' | 'wallet' =>
  openedByReturn ? 'wallet' : 'settings';
