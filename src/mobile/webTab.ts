/**
 * Web wallet: ONE active tab (13 Nov 2026, independent review).
 *
 * Each tab of web.bwalletx.com used to run its own Hub (hub.ts), which serves chrome.storage.local from a copy of
 * localStorage loaded once at start-up, and its own background worker. Nothing kept those copies in step, and every
 * read-merge-write (ChromeStorageService.updateNested, the streaming grants, swap reservations, the storage auto-pay
 * ledger...) wrote the tab's whole stale copy back: an account imported in one tab was removed by the other's next
 * routine write, and a password change in one tab was followed by the other writing accounts under the old key next
 * to the new salt (a lockout).
 *
 * Now only one tab runs the wallet:
 * - The active tab holds the exclusive Web Lock `bwx-web-active` for the life of its wallet (from boot, locked or
 *   not: the worker and the UI write storage while locked too), and writes its id to `bwx.web.activeTab`.
 * - Another tab never builds a Hub, never starts the worker and never loads the UI. It shows one screen, "bWalletX is
 *   open in another tab", with "Use here instead".
 * - "Use here instead" asks the active tab (BroadcastChannel) to fence its hub, flush pending writes and stop its
 *   worker. It answers "released" after writing a marker to localStorage; this tab waits until that marker is
 *   visible (so the old tab's last writes are too), then takes the lock with `steal` and records itself as owner.
 *   Only then does main.ts build the Hub, which loads storage.local fresh from localStorage.
 * - An old tab that never answers (frozen, hung) is stolen from after a wait. Its later writes are still refused:
 *   every storage.local write checks the owner record first (fencedBackend), and a foreign owner retires the tab.
 * - A retired tab reloads (main.ts) and comes back as the same inactive screen.
 * - No Web Locks (old Safari): the owner record alone elects. Any other tab's record means inactive, however old,
 *   since a throttled background tab looks the same as a dead one; the user can always take over. Fails closed: no
 *   readable localStorage means inactive.
 *
 * Web only: phones (Capacitor) and Desktop (Tauri) run one hub per app, and the extension never loads main.ts.
 */
import type { LocalBackend } from './hub';

export const WEB_TAB_LOCK = 'bwx-web-active';
export const WEB_TAB_OWNER_KEY = 'bwx.web.activeTab';
export const WEB_TAB_FLUSH_KEY = 'bwx.web.handedOver';
export const WEB_TAB_CHANNEL = 'bwx-web-tab';
export const MOVED_ERROR = 'bWalletX is open in another tab';

/** The parts of navigator.locks used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebTabEnv {
  /** navigator.locks, or undefined where the browser has none. */
  locks?: LockManagerLike;
  /** A BroadcastChannel shared by this site's tabs, or undefined. */
  openChannel?: () => ChannelLike | undefined;
  /** localStorage, or undefined when it cannot be read (then this tab stays inactive). */
  storage?: StorageLike;
  /** Another tab changed localStorage (the `storage` event). key null = cleared. */
  onStorageEvent?: (listener: (key: string | null) => void) => void;
  newId: () => string;
  now: () => number;
  /** How long "Use here instead" waits for the active tab to let go before taking the lock anyway. */
  takeoverWaitMs?: number;
  /** How long it waits for the old tab's last writes to be visible here. */
  flushWaitMs?: number;
  /** How long a released tab waits to be replaced before it gives the lock back and reloads. */
  stealWaitMs?: number;
  /** No Web Locks: how long a fresh claim waits before checking no other tab claimed at the same moment. */
  claimSettleMs?: number;
}

type Msg = { t: 'takeover'; from: string } | { t: 'released'; by: string; to: string; marker: string };

export type WebTabState = 'inactive' | 'active' | 'releasing' | 'lost';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WebTab {
  readonly id: string;
  state: WebTabState = 'inactive';
  private channel?: ChannelLike;
  private releaseHook: () => Promise<void> = async () => undefined;
  private lostHooks: Array<() => void> = [];
  private letGo?: () => void;
  private waiters = new Set<(m: Msg) => void>();
  private released?: Promise<void>;
  private handingOver = false;

  constructor(private env: WebTabEnv) {
    this.id = env.newId();
    try {
      this.channel = env.openChannel?.();
    } catch {
      this.channel = undefined;
    }
    this.channel?.addEventListener('message', (e) => this.onMessage(e.data));
    env.onStorageEvent?.((key) => {
      if (key === WEB_TAB_OWNER_KEY || key === null) this.checkOwner();
    });
  }

  /** main.ts, once its hub and worker exist: fence the hub, flush its writes and stop the worker. */
  onRelease(fn: () => Promise<void>) {
    this.releaseHook = fn;
  }

  /** main.ts: another tab has the wallet now (reload into the inactive screen). */
  onLost(fn: () => void) {
    this.lostHooks.push(fn);
  }

  /** At boot: become the active tab if no other tab is. Never waits for another tab. */
  async claim(): Promise<boolean> {
    if (!this.env.storage) return false;
    return this.env.locks ? this.claimWithLock(false) : this.claimByRecord(false);
  }

  /** "Use here instead": ask the active tab to flush, stop and let go, then take over. */
  async takeOver(): Promise<boolean> {
    if (this.state === 'active') return true;
    if (!this.env.storage) return false;
    this.state = 'inactive';
    // Nobody has it (the other tab closed): take it straight away.
    if (
      this.env.locks
        ? await this.claimWithLock(false)
        : this.readOwnerSafe() === null && (await this.claimByRecord(false))
    )
      return true;

    const answer = this.waitFor(
      (m): m is Extract<Msg, { t: 'released' }> => m.t === 'released' && m.to === this.id,
      this.env.takeoverWaitMs ?? 3000,
    );
    this.channel?.postMessage({ t: 'takeover', from: this.id } satisfies Msg);
    const released = await answer;
    // The old tab flushed: start only once its last write is visible here, or the hub would load a stale copy.
    if (released && !(await this.markerVisible(released.marker))) return false;
    // No answer: the old tab is frozen, hung or gone. Take it anyway; the owner record refuses its later writes.
    return this.env.locks ? this.claimWithLock(true) : this.claimByRecord(true);
  }

  /**
   * The write fence (fencedBackend): true only while this tab is active and the owner record still names it.
   * Another tab's id there retires this tab; an unreadable record refuses the write.
   */
  isOwner(): boolean {
    if (this.state !== 'active') return false;
    let owner: string | null;
    try {
      owner = this.readOwner();
    } catch {
      return false;
    }
    if (owner === this.id) return true;
    if (owner === null) {
      // The record was cleared under us (site data): we still hold the lock / the claim, so write it again.
      try {
        this.writeOwner();
        return this.readOwner() === this.id;
      } catch {
        return false;
      }
    }
    this.lose();
    return false;
  }

  /** pagehide: without Web Locks, a closing active tab clears its record so the next tab starts by itself. */
  onPageHide() {
    if (this.env.locks || this.state !== 'active') return;
    try {
      if (this.readOwner() === this.id) this.env.storage?.removeItem(WEB_TAB_OWNER_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  // INTERNALS ***************************************************************

  private claimWithLock(steal: boolean): Promise<boolean> {
    const locks = this.env.locks!;
    return new Promise<boolean>((resolve) => {
      let held = false;
      locks
        .request(WEB_TAB_LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(false);
          try {
            this.writeOwner();
            if (this.readOwner() !== this.id) return resolve(false);
          } catch {
            return resolve(false); // cannot record ownership: let the lock go, stay inactive
          }
          held = true;
          this.state = 'active';
          resolve(true);
          return new Promise<void>((done) => (this.letGo = done));
        })
        .then(
          () => {
            if (held) this.lose(); // we let go
          },
          () => {
            if (held)
              this.lose(); // stolen (AbortError)
            else resolve(false); // the request failed
          },
        );
    });
  }

  private async claimByRecord(force: boolean): Promise<boolean> {
    try {
      if (!force && this.readOwner() !== null) return false; // another tab's record, however old: inactive
      this.writeOwner();
      await sleep(this.env.claimSettleMs ?? 300);
      if (this.readOwner() !== this.id) return false; // another tab claimed at the same moment
    } catch {
      return false;
    }
    this.state = 'active';
    return true;
  }

  private writeOwner() {
    this.env.storage!.setItem(WEB_TAB_OWNER_KEY, JSON.stringify({ id: this.id, at: this.env.now() }));
  }

  /** The owner's id, null when there is no record, '?' for a record that can't be read (a foreign owner). */
  private readOwner(): string | null {
    const raw = this.env.storage!.getItem(WEB_TAB_OWNER_KEY);
    if (raw === null) return null;
    try {
      const id = (JSON.parse(raw) as { id?: unknown }).id;
      return typeof id === 'string' && id ? id : '?';
    } catch {
      return '?';
    }
  }

  private readOwnerSafe(): string | null | undefined {
    try {
      return this.readOwner();
    } catch {
      return undefined;
    }
  }

  private checkOwner() {
    if (this.state !== 'active' && this.state !== 'releasing') return;
    const owner = this.readOwnerSafe();
    if (owner !== this.id && owner !== null) this.lose();
  }

  private onMessage(data: unknown) {
    const m = data as Msg;
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    for (const w of [...this.waiters]) w(m);
    if (m.t === 'takeover' && m.from !== this.id && this.state === 'active') void this.handOver(m.from);
  }

  private runRelease(): Promise<void> {
    this.released ??= Promise.race([this.releaseHook().catch(() => undefined), sleep(this.env.flushWaitMs ?? 3000)]);
    return this.released;
  }

  /** Another tab asked for the wallet: fence, flush, stop, mark, answer; then wait to be replaced. */
  private async handOver(to: string) {
    if (this.handingOver) return; // a second asker gets no answer and takes over after its wait
    this.handingOver = true;
    // Still 'active' while the hook flushes: the hub is fenced (no new writes), and the writes it already accepted
    // must still pass the owner check on their way to localStorage.
    await this.runRelease();
    if (this.state !== 'active') return; // stolen meanwhile
    this.state = 'releasing';
    const marker = `${this.id}:${this.env.now()}`;
    try {
      this.env.storage?.setItem(WEB_TAB_FLUSH_KEY, marker);
    } catch {
      /* the new tab then waits and stays inactive */
    }
    this.channel?.postMessage({ t: 'released', by: this.id, to, marker } satisfies Msg);
    // The steal (Web Locks) or the new owner record (storage event) retires this tab; if neither comes (the other
    // tab closed meanwhile), give the lock back and reload, which makes this tab active again.
    setTimeout(() => this.lose(), this.env.stealWaitMs ?? 10_000);
  }

  private lose() {
    if (this.state === 'lost') return;
    const wasActive = this.state === 'active';
    this.state = 'lost';
    // Stolen without a handshake: stop whatever still runs (its writes are already refused).
    const stopped = wasActive ? this.runRelease() : Promise.resolve();
    void stopped.then(() => {
      this.letGo?.();
      this.letGo = undefined;
      for (const fn of this.lostHooks) {
        try {
          fn();
        } catch {
          /* keep going */
        }
      }
    });
  }

  private waitFor<T extends Msg>(match: (m: Msg) => m is T, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const waiter = (m: Msg) => {
        if (!match(m)) return;
        this.waiters.delete(waiter);
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(undefined);
      }, ms);
      this.waiters.add(waiter);
    });
  }

  private async markerVisible(marker: string): Promise<boolean> {
    const until = this.env.now() + (this.env.flushWaitMs ?? 3000);
    for (;;) {
      try {
        if (this.env.storage!.getItem(WEB_TAB_FLUSH_KEY) === marker) return true;
      } catch {
        return false;
      }
      if (this.env.now() >= until) return false;
      await sleep(20);
    }
  }
}

/**
 * storage.local for the active web tab: every write first checks this tab still owns the wallet, so a tab another
 * tab took over (even one too frozen to hear the handover) can never write its stale copy back.
 */
export const fencedBackend = <B extends LocalBackend>(backend: B, tab: Pick<WebTab, 'isOwner'>): B => ({
  ...backend,
  apply: async (sets: Record<string, string>, removes: string[]) => {
    if (!tab.isOwner()) throw new Error(MOVED_ERROR);
    return backend.apply(sets, removes);
  },
});

/** The web edition: not a native phone (Capacitor) and not Desktop (Tauri). The extension never loads main.ts. */
export const isWebEdition = (flags: { native: boolean; tauri: boolean }) => !flags.native && !flags.tauri;

export const WEB_TAB_MESSAGE_KEY = 'bwx.web.tabMessage';

/**
 * No BroadcastChannel (Safari before 15.4, which also lacks Web Locks): messages ride the `storage` event, which
 * fires in every other tab of this site when a key changes. Each message carries a nonce so repeats still fire.
 */
export const storageChannel = (
  storage: StorageLike,
  listen: (fn: (e: { key: string | null; newValue: string | null }) => void) => void,
): ChannelLike => {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  listen((e) => {
    if (e.key !== WEB_TAB_MESSAGE_KEY || !e.newValue) return;
    try {
      const data = (JSON.parse(e.newValue) as { m?: unknown }).m;
      for (const fn of listeners) fn({ data });
    } catch {
      /* not ours */
    }
  });
  return {
    postMessage: (m) => {
      try {
        storage.setItem(WEB_TAB_MESSAGE_KEY, JSON.stringify({ n: Math.random().toString(36).slice(2), m }));
      } catch {
        /* storage full or blocked: the other side times out */
      }
    },
    addEventListener: (_type, fn) => void listeners.push(fn),
  };
};

export const browserWebTabEnv = (): WebTabEnv => {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManagerLike }) : undefined;
  let storage: StorageLike | undefined;
  try {
    storage = window.localStorage;
    storage.getItem(WEB_TAB_OWNER_KEY);
  } catch {
    storage = undefined;
  }
  return {
    locks: typeof nav?.locks?.request === 'function' ? nav.locks : undefined,
    openChannel: () =>
      typeof BroadcastChannel === 'function'
        ? new BroadcastChannel(WEB_TAB_CHANNEL)
        : storage
          ? storageChannel(storage, (fn) => window.addEventListener('storage', fn))
          : undefined,
    storage,
    onStorageEvent: (listener) =>
      window.addEventListener('storage', (e) => {
        if (e.storageArea === null || e.storageArea === storage) listener(e.key);
      }),
    newId: () =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    now: () => Date.now(),
  };
};

/** The one screen an inactive tab shows. Plain DOM: no React, no hub. */
export const showInactiveScreen = (doc: Document, onUse: () => void) => {
  const box = doc.createElement('div');
  box.id = 'bwallet-other-tab';
  box.setAttribute('role', 'main');
  box.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:16px;padding:24px 16px;background:#010101;color:#fff;text-align:center;' +
    'font:16px/1.4 Inter,system-ui,-apple-system,sans-serif';
  const title = doc.createElement('h1');
  title.textContent = 'bWalletX is open in another tab';
  title.style.cssText = 'margin:0;font-size:20px;font-weight:700;max-width:340px';
  const line = doc.createElement('p');
  line.textContent = 'Your wallet runs in one tab at a time, so everything stays in step.';
  line.style.cssText = 'margin:0;opacity:0.7;max-width:320px';
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Use here instead';
  button.style.cssText =
    'padding:12px 32px;border:0;border-radius:999px;background:#f5c518;color:#000;font:inherit;font-weight:700;' +
    'cursor:pointer';
  const note = doc.createElement('p');
  note.style.cssText = 'margin:0;font-size:13px;opacity:0.6;max-width:300px;min-height:18px';
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Moving here…';
    note.textContent = '';
    onUse();
  });
  box.append(title, line, button, note);
  doc.body.appendChild(box);
  return {
    failed: () => {
      button.disabled = false;
      button.textContent = 'Use here instead';
      note.textContent = 'The other tab is still busy. Close it, or try again.';
    },
    remove: () => box.remove(),
  };
};

/**
 * main.ts (web only), before anything that builds a Hub or starts the worker: resolves once this tab is the active
 * one, either straight away or after the user chose "Use here instead".
 */
export const startWebTab = async (env: WebTabEnv = browserWebTabEnv(), doc: Document = document): Promise<WebTab> => {
  const tab = new WebTab(env);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => tab.onPageHide());
    // Back from the back-forward cache: the hub's copy and the lock can't be trusted; start again.
    window.addEventListener('pageshow', (e) => {
      if ((e as PageTransitionEvent).persisted) location.reload();
    });
  }
  if (await tab.claim()) return tab;
  await new Promise<void>((resolve) => {
    const screen = showInactiveScreen(doc, () => {
      void tab.takeOver().then((ok) => {
        if (!ok) return screen.failed();
        screen.remove();
        resolve();
      });
    });
  });
  return tab;
};
