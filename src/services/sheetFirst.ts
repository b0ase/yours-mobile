/**
 * Sheet first, heavy work after (cold-connect latency, 28 Oct 2026).
 *
 * A site's Connect often wakes a stopped extension worker. Opening the wallet used to start the address sync,
 * the message-box sync and the switch to this device's store straight away, and those hold the wallet storage's
 * locks. The permission check behind the approval sheet reads the same storage, so it queued behind them and the
 * sheet took ~2.1 s to appear (warm: ~0.17 s).
 *
 * This gate holds that background work back while a site is waiting for a sheet. It resolves at once when no site
 * asked for anything recently (a popup open, an alarm), otherwise on the first of:
 *   - a sheet (or the unlock screen) is on screen,
 *   - the site has been quiet for `quietMs` since the wallet was ready (its calls needed no sheet),
 *   - `capMs` has passed (never holds the work back for long).
 * It only changes when the work starts, never what it does.
 */

export interface SheetFirstOptions {
  /** A site request this recent (ms) counts as "a site is waiting". */
  recentMs?: number;
  /** No new site request for this long (ms) releases the gate. */
  quietMs?: number;
  /** Upper bound (ms) on how long the gate holds. */
  capMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const SHEET_FIRST_RECENT_MS = 5_000;
export const SHEET_FIRST_QUIET_MS = 1_000;
export const SHEET_FIRST_CAP_MS = 3_000;

export class SheetFirstGate {
  private lastSiteAt = Number.NEGATIVE_INFINITY;
  private waitingSince = Number.NEGATIVE_INFINITY;
  private waiters: (() => void)[] = [];
  private quietTimer: unknown;
  private capTimer: unknown;
  private readonly recentMs: number;
  private readonly quietMs: number;
  private readonly capMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: SheetFirstOptions = {}) {
    this.recentMs = options.recentMs ?? SHEET_FIRST_RECENT_MS;
    this.quietMs = options.quietMs ?? SHEET_FIRST_QUIET_MS;
    this.capMs = options.capMs ?? SHEET_FIRST_CAP_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** A site (not our own pages) sent the wallet a request. */
  noteSiteRequest(): void {
    this.lastSiteAt = this.now();
    if (this.waiters.length > 0) this.armQuiet();
  }

  /** A sheet or the unlock screen is showing: the person has something to look at, the work may start. */
  notePromptShown(): void {
    this.release();
  }

  /** Resolves when the background work may start. */
  wait(): Promise<void> {
    if (this.now() - this.lastSiteAt >= this.recentMs) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (this.waiters.length === 1) {
        this.waitingSince = this.now();
        this.armQuiet();
        this.capTimer = this.setTimer(() => this.release(), this.capMs);
      }
    });
  }

  private armQuiet(): void {
    if (this.quietTimer !== undefined) this.clearTimer(this.quietTimer);
    // Quiet counts from the later of the site's last call and the wallet becoming ready: the call that woke the
    // worker waits for the wallet, and its follow-up (getPublicKey after waitForAuthentication) comes only then.
    const left = Math.max(0, Math.max(this.lastSiteAt, this.waitingSince) + this.quietMs - this.now());
    this.quietTimer = this.setTimer(() => this.release(), left);
  }

  private release(): void {
    if (this.quietTimer !== undefined) this.clearTimer(this.quietTimer);
    if (this.capTimer !== undefined) this.clearTimer(this.capTimer);
    this.quietTimer = undefined;
    this.capTimer = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
