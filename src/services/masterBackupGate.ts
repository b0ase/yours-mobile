/**
 * Holds wallet requests while a master backup runs, instead of refusing them.
 *
 * The backup closes the live wallet and opens each account's storage in turn; no wallet may come up meanwhile. Wallet
 * calls that landed then (the app-wide profile, bMail badge, balances…) used to fail with "Wallet is busy with a
 * master backup" (~40 console errors per backup; release check, 19 Oct 2026). They now wait until the backup has
 * finished and the original account is open again, then carry on.
 */
/** Longest a wallet request waits for a running master backup before failing. */
export const MASTER_BACKUP_WAIT_MS = 5 * 60_000;

export const createMasterBackupGate = () => {
  let done: Promise<void> | null = null;
  let release: (() => void) | null = null;
  return {
    get active() {
      return done !== null;
    },
    /** The backup starts: from now until end(), wait() holds callers. */
    begin() {
      if (done) return;
      done = new Promise<void>((r) => (release = r));
    },
    /** The backup is over and the original account is back (or failed to come back): let callers through. */
    end() {
      const r = release;
      done = null;
      release = null;
      r?.();
    },
    /**
     * Resolves at once when no backup runs, otherwise when it ends. A backup that never ends must not hold wallet
     * requests forever: after `timeoutMs` the wait rejects with the old "busy" error so callers fail visibly.
     */
    wait(timeoutMs = MASTER_BACKUP_WAIT_MS): Promise<void> {
      if (!done) return Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Wallet is busy with a master backup; try again in a moment')),
          timeoutMs,
        );
      });
      return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
    },
  };
};
