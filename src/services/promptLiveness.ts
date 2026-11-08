/**
 * BRC-219, the Wallet Permission Prompt Liveness Contract (owner, 8 Nov 2026).
 *
 * A site's request that waits on the person stays pending until they answer: an approval sheet that is up never
 * expires on a timer (the 60 s PROMPT_EXPIRY_MS is gone). A waiting request still fails, clearly, when:
 *  - its prompt was never shown (promptWatchdog.ts, ERR_PROMPT_NOT_SHOWN; unchanged);
 *  - it waits behind another sheet the person can see for too long (promptWatchdog.ts, ERR_PROMPT_BUSY; unchanged);
 *  - the prompt surface is gone: the person closed the window, the side panel or the in-page sheet (background.ts
 *    denyAllPendingPrompts; unchanged), or the unlock screen it waits on (unlockSurfaceGone below);
 *  - the caller is gone: the page, browser or frame that asked was closed or left (CallerRegistry below,
 *    ERR_PROMPT_CALLER_GONE).
 *
 * Failing a request here is the same as Deny before anything was built or signed: it rejects the permission request
 * itself and never touches a transaction (noSend / unsent release logic is elsewhere and unchanged).
 */

export const PROMPT_CALLER_GONE_CODE = 'ERR_PROMPT_CALLER_GONE';
export const PROMPT_CALLER_GONE_MESSAGE =
  'The page that asked for this was closed or left before you answered, so bWalletX closed its sheet. Nothing was paid or signed.';

/** An Error a site can tell apart: code ERR_PROMPT_CALLER_GONE, status 410. */
export function promptCallerGoneError(): Error & { code: string; status: number } {
  return Object.assign(new Error(PROMPT_CALLER_GONE_MESSAGE), { code: PROMPT_CALLER_GONE_CODE, status: 410 });
}

/** The port a caller opens for each wallet call; it disconnects when the calling document goes away. */
export const LIVE_PORT_NAME = 'bwx-live';

/** A sheet as the registry sees it: its map kind and id, the site that asked, and whether it is a payment. */
export type SheetRef = { kind: string; id: string; site: string; payment?: boolean };

type Call = { site: string; action: string; owners: Set<string>; dead: boolean };

/**
 * Who is still waiting for each wallet call, and which open sheets could belong to it (BRC-219 caller-gone).
 *
 * Each site call carries a liveness token from its caller: the extension's content script (one port per call, which
 * Chrome disconnects when that document unloads: close, reload, navigation, bfcache, prerender swap) or the phone's
 * dApp browser / bApp frame session. A sheet cannot say which call raised it, so when it is raised its candidate
 * owners are the site's calls in flight at that moment (for a payment sheet, only its createAction calls). A call
 * that answers leaves every candidate set (it was not waiting on that sheet).
 *
 * When a caller goes, its calls die unless another caller joined them (a deduped Retry: alive while one of its own
 * callers is). Every open sheet with a candidate that just died is closed: exact when one call could own it (the
 * usual case); when two documents of one site had calls in flight as the sheet was raised, it fails closed (the live
 * one gets a clear error and can ask again) rather than leave a sheet that could pay for a caller that is gone.
 *
 * A payment sheet is bound to its own call (third review, 8 Nov 2026): the payment run of that call's createAction
 * carries its token (CALLER_TOKEN on the args), so its owner is exact, never guessed. For other sheets, a dead call is
 * never a candidate for a sheet raised after it died (re-review, 8 Nov 2026): the live page's sheet is owned by the
 * live calls. Only when NO live call could own a new sheet, and a dead one could, is it closed at once
 * (the dead call's own late request). Dead calls are also made to end promptly: `whenGone` / `guard` let the
 * background reject a dead call's pre-approval waits (unlock, funding, the payment-run wait), so a reload while locked
 * does not leave a second, ownerless call to resume on unlock.
 *
 * Only calls that carry a token and will be answered are counted; nothing else (no per-site, per-tab counting).
 */
export class CallerRegistry {
  private calls = new Map<string, Call>();
  private sheets = new Map<string, { ref: SheetRef; candidates: Set<string> }>();
  private gone = new Set<string>();
  private goneOrder: string[] = [];
  private goneWaiters = new Map<string, (() => void)[]>();

  private key = (kind: string, id: string) => `${kind}\u0000${id}`;

  /** A call with liveness token `token` started. Returns false when its caller is already gone. */
  start(token: string, site: string, action: string): boolean {
    const dead = this.gone.has(token);
    this.calls.set(token, { site, action, owners: new Set([token]), dead });
    return !dead;
  }

  /** `joiner`'s call joined the call `target` (createActionDedupe): one call, two callers. */
  join(target: string, joiner: string): void {
    const call = this.calls.get(target);
    this.calls.delete(joiner);
    for (const s of this.sheets.values()) s.candidates.delete(joiner);
    if (!call || call.dead) return;
    if (!this.gone.has(joiner)) call.owners.add(joiner);
  }

  /** The call was answered. */
  end(token: string): void {
    this.calls.delete(token);
    this.goneWaiters.delete(token);
    for (const s of this.sheets.values()) s.candidates.delete(token);
  }

  /**
   * A sheet was raised. Returns true when it must be closed at once. `owner`: the call that raised it, when known
   * (payment sheets); otherwise its owners are guessed from the site's calls in flight (see the class comment).
   */
  raise(ref: SheetRef, owner?: string): boolean {
    // A payment sheet bound to its own call (spendRecipients.ts: the run of that call's createAction carries its
    // token): owned by exactly that call and the callers who joined it. Already dead -> close at once.
    if (owner && (this.calls.has(owner) || this.gone.has(owner))) {
      this.sheets.set(this.key(ref.kind, ref.id), { ref, candidates: new Set([owner]) });
      return this.isDead(owner);
    }
    const site = [...this.calls].filter(([, c]) => c.site === ref.site);
    // A payment sheet comes from a createAction; if none is in flight, any of the site's calls may own it.
    const pays = ref.payment ? site.filter(([, c]) => c.action === 'createAction') : [];
    const owners = pays.length ? pays : site;
    // Owned by the calls still wanted: a call that died before this sheet existed is not one of its owners.
    const live = owners.filter(([, c]) => !c.dead).map(([token]) => token);
    this.sheets.set(this.key(ref.kind, ref.id), { ref, candidates: new Set(live) });
    // Nothing alive could own it, but a dead call could: it is that call's own late request. Close it at once.
    return live.length === 0 && owners.length > 0;
  }

  /** True when the call `token` has lost every caller (or its caller left before it started). */
  isDead(token: string | undefined): boolean {
    if (!token) return false;
    const c = this.calls.get(token);
    return c ? c.dead : this.gone.has(token);
  }

  /** Resolves when the call `token` loses its last caller (at once if it already has). Never rejects. */
  whenGone(token: string): Promise<void> {
    if (this.isDead(token)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.goneWaiters.get(token) ?? [];
      list.push(resolve);
      this.goneWaiters.set(token, list);
    });
  }

  /**
   * `work` for the call `token`, or a prompt ERR_PROMPT_CALLER_GONE rejection if its caller goes first. For waits
   * BEFORE any sheet (unlock, funding): the waiting step itself is left to finish on its own; the call ends now.
   */
  guard<T>(token: string | undefined, work: Promise<T>): Promise<T> {
    if (!token) return work;
    if (this.isDead(token)) return Promise.reject(promptCallerGoneError());
    return Promise.race([
      work,
      this.whenGone(token).then(() => {
        throw promptCallerGoneError();
      }),
    ]);
  }

  /** The sheet was answered or closed. */
  settle(kind: string, id: string): void {
    this.sheets.delete(this.key(kind, id));
  }

  /** The caller holding `token` went away. Returns the open sheets to close now (never approves anything). */
  callerGone(token: string): SheetRef[] {
    this.gone.add(token);
    this.goneOrder.push(token);
    while (this.goneOrder.length > 2000) this.gone.delete(this.goneOrder.shift()!);
    const died = new Set<string>();
    for (const [id, c] of this.calls) {
      if (!c.owners.delete(token)) continue;
      if (c.owners.size === 0 && !c.dead) {
        c.dead = true;
        died.add(id);
      }
    }
    for (const id of died) {
      const waiters = this.goneWaiters.get(id) ?? [];
      this.goneWaiters.delete(id);
      for (const w of waiters) w();
    }
    if (died.size === 0) return [];
    const close: SheetRef[] = [];
    for (const [k, s] of this.sheets) {
      if (![...s.candidates].some((t) => died.has(t))) continue;
      close.push(s.ref);
      this.sheets.delete(k);
    }
    return close;
  }

  /** For tests and logs. */
  inFlight(site?: string): number {
    let n = 0;
    for (const c of this.calls.values()) if (!site || c.site === site) n++;
    return n;
  }
  openSheets(): SheetRef[] {
    return [...this.sheets.values()].map((s) => s.ref);
  }
}

/**
 * Remove the waiters of the call `token` from a wait list (background.ts pendingWalletWaiters) without answering them
 * (the call was already answered by CallerRegistry.guard). Returns how many were removed and how many are left.
 */
export const dropTokenWaiters = <W extends { token?: string }>(
  list: W[],
  token: string | undefined,
): { removed: number; left: number } => {
  if (!token) return { removed: 0, left: list.length };
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i].token === token) {
      list.splice(i, 1);
      removed++;
    }
  return { removed, left: list.length };
};

/** What background.ts needs from a chrome.runtime.Port for the liveness port. */
export type LivePortLike = {
  onMessage: { addListener: (fn: (m: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
};

/**
 * background.ts onConnect for a 'bwx-live' port: the port names its call's token in its first message; when it
 * disconnects (the calling document, browser or frame went away) that call loses this caller, and the sheets it
 * could own are handed to `close`. The port carries nothing else.
 */
export const attachLivePort = (port: LivePortLike, registry: CallerRegistry, close: (refs: SheetRef[]) => void) => {
  let token: string | undefined;
  port.onMessage.addListener((m) => {
    const t = (m as { token?: unknown } | null)?.token;
    if (token === undefined && typeof t === 'string' && t.length > 0 && t.length <= 100) token = t;
  });
  port.onDisconnect.addListener(() => {
    if (token !== undefined) close(registry.callerGone(token));
  });
};

/**
 * Carried on a site's createAction arguments (an enumerable symbol, so copies made with spread keep it and JSON
 * drops it): a promise that resolves when that call's caller is gone. spendRecipients.ts stops waiting behind a
 * look-alike payment then, so a dead call never goes on to raise a sheet.
 */
export const CALLER_GONE_SIGNAL: unique symbol = Symbol.for('bwalletx.callerGone');

/** The liveness token of the call these createAction args belong to (same carriage as CALLER_GONE_SIGNAL). */
export const CALLER_TOKEN: unique symbol = Symbol.for('bwalletx.callerToken');

export const withCallerGoneSignal = <T extends object>(args: T, gone: Promise<void> | undefined, token?: string): T => {
  if (gone) (args as Record<symbol, unknown>)[CALLER_GONE_SIGNAL] = gone;
  if (token) (args as Record<symbol, unknown>)[CALLER_TOKEN] = token;
  return args;
};

export const callerTokenOf = (args: unknown): string | undefined => {
  const t = args && typeof args === 'object' ? (args as Record<symbol, unknown>)[CALLER_TOKEN] : undefined;
  return typeof t === 'string' ? t : undefined;
};

/**
 * The hooks every tracked sheet map in background.ts uses: raise into the registry (a payment sheet with the exact
 * owner `paymentOwner` reports: its run's call), close at once what the registry says to, settle on answer.
 */
export const sheetHooksFor = (
  registry: CallerRegistry,
  opts: {
    siteOf: (originator: string) => string;
    paymentOwner: (kind: string, id: string) => string | undefined;
    close: (refs: SheetRef[]) => void;
    settled?: (kind: string, id: string) => void;
    defer?: (fn: () => void) => void;
  },
): SheetHooks => ({
  siteOf: opts.siteOf,
  raised: (ref) => {
    const owner = ref.payment ? opts.paymentOwner(ref.kind, ref.id) : undefined;
    if (registry.raise(ref, owner)) (opts.defer ?? queueMicrotask)(() => opts.close([ref]));
  },
  settled: (kind, id) => {
    registry.settle(kind, id);
    opts.settled?.(kind, id);
  },
});

export const callerGoneSignalOf = (args: unknown): Promise<void> | undefined => {
  const g = args && typeof args === 'object' ? (args as Record<symbol, unknown>)[CALLER_GONE_SIGNAL] : undefined;
  return g instanceof Promise ? (g as Promise<void>) : undefined;
};

/**
 * "This site asked again" (BRC-219 review, 8 Nov 2026). With no expiry, a Retry that is not identical (a fresh
 * reference) is its own call and gets its own sheet after the first is answered (the bundler shows one sheet per site
 * at a time; a payment that arrives while one is up joins it only as an unticked "New" line). If the person approved
 * the first, approving the second pays again. So a payment sheet whose outputs match one this site asked for within
 * ASKED_AGAIN_MS says so, plainly, before the person answers. Display only: nothing is refused (games and tips repeat
 * identical payments on purpose).
 */
export const ASKED_AGAIN_MS = 10 * 60_000;

export class AskedAgain {
  private seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Note a payment sheet for `site` paying exactly `hash`. Returns seconds since the same one was last asked, or null. */
  note(site: string, hash: string): number | null {
    const k = `${site}\u0000${hash}`;
    const t = this.now();
    const last = this.seen.get(k);
    this.seen.set(k, t);
    for (const [key, at] of this.seen) if (t - at > ASKED_AGAIN_MS) this.seen.delete(key);
    return last !== undefined && t - last <= ASKED_AGAIN_MS ? Math.max(0, Math.round((t - last) / 1000)) : null;
  }
}

export type UnlockSurfaceState = {
  /** Site calls waiting on the wallet (pendingWalletWaiters). */
  waiting: number;
  /** They wait on Create / Restore, not unlock: the setup wait handles its own window (walletSetupWait.ts). */
  setup: boolean;
  /** An unlock (or account switch) is already finishing: the waiters are about to be answered. */
  unlocking: boolean;
  /** Open wallet panels (the side panel or toolbar popup; the phone and web wallet UI itself). */
  panels: number;
  /** The wallet's own prompt window is open. */
  popupWindow: boolean;
  /** The in-page sheet is over a site. */
  inPageSheet: boolean;
};

/**
 * True when site calls wait for an unlock and nothing can show the unlock screen any more: no panel, no prompt window
 * and no in-page sheet. The waiters are then failed (a lifecycle error, not a timeout). While any of those is up the
 * unlock waits for the person however long they take (BRC-219).
 */
export const unlockSurfaceGone = (s: UnlockSurfaceState): boolean =>
  s.waiting > 0 && !s.setup && !s.unlocking && s.panels === 0 && !s.popupWindow && !s.inPageSheet;

/** Something is up the person can still answer for this site: an open sheet, or the unlock / setup screen. */
export type SiteAskingState = {
  /** The site's open sheets that the prompt UI has confirmed it is showing (or that wait behind one it is). */
  shownSheets: number;
  /** Other sheets of the site that wait for their own answer (1Sat, envelopes, private mints, Twetch, holdings). */
  otherSheets: number;
  /** Site calls waiting on the unlock or wallet setup screen. */
  walletWaiters: number;
};

/**
 * The phone/web bridge's ceiling hit for a site's call (mobile/dappBrowser.ts): true while the person can still answer
 * it, so the bridge keeps waiting instead of closing the sheet and telling the site "timed out" (BRC-219).
 */
export const siteStillAsking = (s: SiteAskingState): boolean =>
  s.shownSheets > 0 || s.otherSheets > 0 || s.walletWaiters > 0;

export type SheetHooks = {
  /** The site key a sheet's originator maps to (the same key the registry's calls use). */
  siteOf: (originator: string) => string;
  raised: (ref: SheetRef) => void;
  settled: (kind: string, id: string) => void;
};

/**
 * A pending-sheet map (background.ts pendingPermissionRequests and friends) that tells the CallerRegistry when a
 * sheet is raised and when it is answered or closed. Behaves exactly like a Map otherwise.
 */
export class TrackedSheets<V extends { request: { originator?: string; type?: string } }> extends Map<string, V> {
  private readonly sheetKind: string;
  private readonly hooks: SheetHooks;
  constructor(kind: string, hooks: SheetHooks) {
    super();
    this.sheetKind = kind;
    this.hooks = hooks;
  }
  override set(id: string, v: V): this {
    const fresh = !this.has(id);
    super.set(id, v);
    // Map's constructor never calls set here (no entries), so hooks is always assigned by now.
    if (fresh && this.hooks) {
      const o = v?.request?.originator;
      this.hooks.raised({
        kind: this.sheetKind,
        id,
        site: typeof o === 'string' ? this.hooks.siteOf(o) : '',
        ...(v?.request?.type === 'spending' ? { payment: true } : {}),
      });
    }
    return this;
  }
  override delete(id: string): boolean {
    const had = super.delete(id);
    if (had) this.hooks.settled(this.sheetKind, id);
    return had;
  }
  override clear(): void {
    for (const id of [...this.keys()]) this.hooks.settled(this.sheetKind, id);
    super.clear();
  }
}
