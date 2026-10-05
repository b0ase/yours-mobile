/**
 * "Back up your wallet": pure decisions + the small amount of state they need. The backup itself
 * (encrypted file / recovery phrase) is in backupFile.ts and BackupStep.tsx. Nothing here ever
 * holds or logs a phrase, key or password.
 *
 * Per account, in account.settings (persisted with the other account settings):
 *   backedUpAt       ms timestamp of the last completed backup (unset = not backed up)
 *   backupMethod     'file' (encrypted master backup) | 'phrase' (written down + quiz)
 *   backupCheckedAt  last "Yes, I still have it" answer to the 30-day reminder
 */
import type { ChromeStorageService } from '../../services/ChromeStorage.service';

export type BackupMethod = 'file' | 'phrase';
export type BackupSettings = { backedUpAt?: number; backupMethod?: BackupMethod; backupCheckedAt?: number };

/** Why the Backup step is open. */
export type BackupReason = 'onboarding' | 'receive' | 'balance' | 'banner';
/** How the user may leave it without completing a backup. */
export type BackupExit = 'none' | 'remind-later' | 'skip' | 'cancel' | 'close';

export const REMINDER_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export const isBackedUp = (s?: BackupSettings | null) => typeof s?.backedUpAt === 'number' && s.backedUpAt > 0;

/**
 * Web app: the step is mandatory after create / restore ("Remind me later" only while the balance
 * is zero) and before Receive (leaving just cancels the receive). Native apps / extension: "Skip"
 * (with a warning), which carries on. A balance-triggered or banner-opened step can be closed.
 */
export const backupExit = (reason: BackupReason, web: boolean, balanceZero: boolean): BackupExit => {
  if (reason === 'balance' || reason === 'banner') return 'close';
  if (!web) return 'skip';
  if (reason === 'receive') return 'cancel';
  return balanceZero ? 'remind-later' : 'none';
};

/** Web app only: open the step once per session when money shows up on an un-backed-up wallet. */
export const shouldOpenForBalance = (web: boolean, backedUp: boolean, sats: number, alreadyThisSession: boolean) =>
  web && !backedUp && sats > 0 && !alreadyThisSession;

/** iPhone web app: "Still have your backup?" every 30 days after the backup (or the last "Yes"). */
export const reminderDue = (s: BackupSettings | null | undefined, now: number, days = REMINDER_DAYS) => {
  if (!isBackedUp(s)) return false;
  const last = Math.max(s!.backedUpAt!, s!.backupCheckedAt ?? 0);
  return now - last >= days * DAY;
};

/** `count` distinct 0-based word positions out of `words`, ascending. `rand` returns [0, 1). */
export const pickQuizPositions = (words: number, count = 3, rand: () => number = Math.random): number[] => {
  const n = Math.max(0, Math.min(count, words));
  const pool = Array.from({ length: words }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n).sort((a, b) => a - b);
};

/** Quiz answer check: trimmed, case-insensitive. */
export const quizCorrect = (words: string[], positions: number[], answers: string[]) =>
  positions.length > 0 &&
  positions.every((p, i) => (answers[i] ?? '').trim().toLowerCase() === (words[p] ?? '').toLowerCase());

export const backupFileName = (now = new Date()) => `bwallet-backup-${now.toISOString().slice(0, 10)}.zip`;

// ── account settings ──────────────────────────────────────────────────────────────────────────

const EVENT = 'bwallet-backup-change';
const fire = () => {
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};
export const onBackupChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

export const currentBackupSettings = (cs: ChromeStorageService): BackupSettings & { id?: string } => {
  const { account } = cs.getCurrentAccountObject();
  const s = (account?.settings ?? {}) as BackupSettings;
  return {
    id: account?.addresses?.identityAddress,
    backedUpAt: s.backedUpAt,
    backupMethod: s.backupMethod,
    backupCheckedAt: s.backupCheckedAt,
  };
};

const saveSettings = async (cs: ChromeStorageService, patch: BackupSettings) => {
  const { account } = cs.getCurrentAccountObject();
  if (!account) return;
  await cs.updateNested('accounts', {
    [account.addresses.identityAddress]: { ...account, settings: { ...account.settings, ...patch } },
  });
  fire();
};

export const markBackedUp = (cs: ChromeStorageService, method: BackupMethod, now = Date.now()) =>
  saveSettings(cs, { backedUpAt: now, backupMethod: method, backupCheckedAt: now });

export const markBackupChecked = (cs: ChromeStorageService, now = Date.now()) =>
  saveSettings(cs, { backupCheckedAt: now });

// ── "open after create / restore" flag and session flags (localStorage / sessionStorage) ─────

const PENDING = 'bwallet.backupPrompt.pending';
const BALANCE_SEEN = 'bwallet.backupPrompt.balanceShown';
const REMINDER_SEEN = 'bwallet.backupPrompt.reminderShown';

const safe = (kind: 'local' | 'session'): Storage | null => {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
};

/** Set by the create / restore flows (via markHandlePrompt) for the new account. */
export const markBackupPrompt = (id: string | undefined) => {
  if (!id) return;
  safe('local')?.setItem(PENDING, id);
  fire();
};
export const pendingBackupPrompt = (): string | null => safe('local')?.getItem(PENDING) ?? null;
export const clearBackupPrompt = () => {
  safe('local')?.removeItem(PENDING);
  fire();
};

export const balancePromptShown = () => safe('session')?.getItem(BALANCE_SEEN) === '1';
export const setBalancePromptShown = () => safe('session')?.setItem(BALANCE_SEEN, '1');
export const reminderShownThisSession = () => safe('session')?.getItem(REMINDER_SEEN) === '1';
export const setReminderShown = () => safe('session')?.setItem(REMINDER_SEEN, '1');

// ── "open the Backup step" requests (Receive gate, banner) ───────────────────────────────────

export type BackupRequest = { reason: BackupReason; onDone?: () => void };
let opener: ((r: BackupRequest) => void) | null = null;
/** BackupGate (Wallet tab) registers itself; returns the unregister function. */
export const registerBackupOpener = (fn: (r: BackupRequest) => void) => {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
};
/**
 * Run `next` (e.g. show Receive) if this account is backed up; otherwise open the Backup step
 * first and run `next` only once it is completed (or skipped, where skipping is allowed).
 */
export const requestBackupThen = (cs: ChromeStorageService, next: () => void, reason: BackupReason = 'receive') => {
  if (isBackedUp(currentBackupSettings(cs)) || !opener) return next();
  opener({ reason, onDone: next });
};
