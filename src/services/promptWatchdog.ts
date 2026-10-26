/**
 * Prompt watchdog: no site waits on a sheet nobody can see (TokenBlaster NPG Arena, 26 Oct 2026).
 *
 * The owner pressed START, the game asked for $0.10, and no approval sheet ever appeared; the game waited three
 * minutes. Every route the background takes to show a sheet (side panel, in-page sheet, popup window) can fail
 * quietly: a stale in-page sheet or panel flag swallows the prompt, or a request waits behind a site's earlier
 * sheet whose window is long gone. Nothing timed out, so the page's promise never settled.
 *
 * Now each prompt must be confirmed within `confirmMs` by the prompt UI loading its payload (GET_PROMPT_PAYLOAD).
 * If it is not, the watchdog escalates once (the caller clears stale surfaces and opens the wallet's own popup
 * window). If that is not confirmed within another `confirmMs` either, the request is failed with
 * PROMPT_NOT_SHOWN_CODE, so the site's call rejects and it can offer Retry.
 *
 * A prompt that waits behind another one the user is looking at (one at a time, services/promptQueue.ts) is not
 * failed: the caller says so through `waitingBehindShown`, and the watchdog keeps waiting.
 *
 * Failing a request is the same as the user pressing Deny before anything was built or signed: it never touches
 * a transaction (noSend / unsent release logic is elsewhere and unchanged).
 */

export const PROMPT_NOT_SHOWN_CODE = 'ERR_PROMPT_NOT_SHOWN';
export const PROMPT_NOT_SHOWN_MESSAGE =
  'bWalletX could not show its approval sheet. Click the bWalletX icon in your toolbar, then try again.';
/** How long a prompt UI has to confirm it is showing a prompt, per stage. */
export const PROMPT_CONFIRM_MS = 4000;

/** An Error a site can tell apart: code ERR_PROMPT_NOT_SHOWN, status 503. */
export function promptNotShownError(): Error & { code: string; status: number } {
  return Object.assign(new Error(PROMPT_NOT_SHOWN_MESSAGE), { code: PROMPT_NOT_SHOWN_CODE, status: 503 });
}

/**
 * A payment sheet nobody answered within PROMPT_EXPIRY_MS expires (TokenBlaster #105 retries the same createAction
 * after 20 s). Only requests not yet approved or signed: the expiry rejects the permission request itself, so the
 * wallet never builds the transaction; it has nothing to do with noSend / unsent release logic.
 */
export const PROMPT_EXPIRED_CODE = 'ERR_PROMPT_EXPIRED';
export const PROMPT_EXPIRED_MESSAGE =
  'This payment request expired before it was approved. Nothing was paid; try again.';
export const PROMPT_EXPIRY_MS = 60_000;

export function promptExpiredError(): Error & { code: string; status: number } {
  return Object.assign(new Error(PROMPT_EXPIRED_MESSAGE), { code: PROMPT_EXPIRED_CODE, status: 408 });
}

const CODED: [string, string, number][] = [
  [PROMPT_NOT_SHOWN_MESSAGE, PROMPT_NOT_SHOWN_CODE, 503],
  [PROMPT_EXPIRED_MESSAGE, PROMPT_EXPIRED_CODE, 408],
];

/** Adds the code to a `{ success: false, error }` reply whose error is the not-shown or expired failure. */
export function withPromptNotShownCode<R>(response: R): R {
  const r = response as { success?: unknown; error?: unknown; code?: unknown } | null | undefined;
  if (!r || typeof r !== 'object' || r.success !== false || r.code !== undefined) return response;
  if (typeof r.error !== 'string') return response;
  const hit = CODED.find(([m]) => (r.error as string).includes(m));
  if (!hit) return response;
  return { ...r, error: hit[0], code: hit[1], status: hit[2] } as R;
}

export type WatchedPrompt = { kind: string; requestID: string };

export interface PromptWatchdogDeps {
  /** The request is still waiting for an answer. */
  isPending: (p: WatchedPrompt) => boolean;
  /** Another prompt the user can see is up, and this one is queued behind it: keep waiting. */
  waitingBehindShown: (p: WatchedPrompt) => boolean;
  /** First miss: clear stale surfaces and open the wallet's own window for this prompt. */
  escalate: (p: WatchedPrompt) => void;
  /** Second miss: reject the request with promptNotShownError(). */
  fail: (p: WatchedPrompt) => void;
  confirmMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string, p: WatchedPrompt) => void;
}

type Entry = { stage: 0 | 1; timer: unknown };

export class PromptWatchdog {
  private entries = new Map<string, Entry>();
  constructor(private readonly deps: PromptWatchdogDeps) {}

  private key = (p: WatchedPrompt) => `${p.kind}\u0000${p.requestID}`;
  private set = (fn: () => void) =>
    (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, this.deps.confirmMs ?? PROMPT_CONFIRM_MS);
  private clear = (h: unknown) =>
    (this.deps.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);

  /** A prompt was asked to show (again). Restarts its clock; an earlier confirmation does not count. */
  watch(p: WatchedPrompt): void {
    const k = this.key(p);
    const old = this.entries.get(k);
    // Already escalated: let that window's clock run out rather than starting over (no endless retries).
    if (old?.stage === 1) return;
    if (old) this.clear(old.timer);
    this.entries.set(k, { stage: 0, timer: this.set(() => this.tick(p)) });
  }

  /** The prompt UI loaded this prompt's payload: it is on screen. */
  confirm(p: WatchedPrompt): void {
    const k = this.key(p);
    const e = this.entries.get(k);
    if (!e) return;
    this.clear(e.timer);
    this.entries.delete(k);
  }

  /** Stop watching (answered, denied or gone). */
  forget(p: WatchedPrompt): void {
    this.confirm(p);
  }

  watching(p: WatchedPrompt): boolean {
    return this.entries.has(this.key(p));
  }

  private tick(p: WatchedPrompt): void {
    const k = this.key(p);
    const e = this.entries.get(k);
    if (!e) return;
    if (!this.deps.isPending(p)) {
      this.entries.delete(k);
      return;
    }
    if (this.deps.waitingBehindShown(p)) {
      // Queued behind a sheet the user is looking at: check again later, never fail it for waiting its turn.
      e.timer = this.set(() => this.tick(p));
      return;
    }
    if (e.stage === 0) {
      this.deps.log?.('[promptWatchdog] prompt not confirmed: opening the wallet window', p);
      e.stage = 1;
      e.timer = this.set(() => this.tick(p));
      this.deps.escalate(p);
      return;
    }
    this.deps.log?.('[promptWatchdog] prompt still not shown: failing the request', p);
    this.entries.delete(k);
    this.deps.fail(p);
  }
}

type ManagerLike = {
  denyPermission?: (requestID: string) => Promise<void>;
  activeRequests?: Map<string, { pending?: { reject: (e: unknown) => void }[] }>;
};

/**
 * Settle the permission manager's own pending request with `err`, so the site's call rejects with our code instead of
 * the toolbox's plain "Permission denied." (its denyPermission always uses that). Falls back to denyPermission when
 * the manager does not expose its requests. Never grants anything.
 */
export async function rejectManagerRequest(manager: unknown, requestID: string, err: Error): Promise<void> {
  const m = manager as ManagerLike | null | undefined;
  const active = m?.activeRequests;
  const matching = active instanceof Map ? active.get(requestID) : undefined;
  if (matching && Array.isArray(matching.pending)) {
    for (const x of matching.pending) x.reject(err);
    active!.delete(requestID);
    return;
  }
  await m?.denyPermission?.(requestID);
}
