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
 *   not: the worker and the UI write storage while locked too). Where there are Web Locks, the HELD LOCK is the
 *   authority; the owner record `bwx.web.activeTab` in localStorage is a best-effort extra (a full localStorage never
 *   keeps a tab from starting).
 * - Another tab never builds a Hub, never starts the worker and never loads the UI. It shows one screen, "bWalletX is
 *   open in another tab", with "Use here instead" (or a storage message when localStorage is full or unreadable).
 * - "Use here instead" asks the active tab (BroadcastChannel, or storage events) to let a running payment finish (up
 *   to 20 s: "Finishing a payment in the other tab…"), fence its hub, flush pending writes and stop its worker. It
 *   answers "released" after writing a marker to localStorage; this tab waits until that marker is visible (so the old
 *   tab's last writes are too), then takes the lock with `steal`. Only then does main.ts build the Hub, which loads
 *   storage.local fresh from localStorage. One takeover at a time (lock `bwx-web-takeover`).
 * - An old tab that never answers (frozen, hung) is stolen from after a wait. Its later writes are still refused:
 *   every storage.local write first asks the browser (navigator.locks.query, answered by the browser process, not a
 *   cached copy) whether this tab still holds `bwx-web-active` (fencedBackend). Without query(), a newer owner record
 *   than this tab's own start retires it.
 * - A retired tab reloads (main.ts) and comes back as the same inactive screen.
 * - No Web Locks (old Safari): the owner record alone elects. Any other tab's record means inactive, however old,
 *   since a throttled background tab looks the same as a dead one; the user can always take over. Fails closed: no
 *   readable localStorage means inactive.
 *
 * Web only: phones (Capacitor) and Desktop (Tauri) run one hub per app, and the extension never loads main.ts.
 */
import type { LocalBackend } from './hub';
import { isQuotaError as isQuota } from './atomicStorage';
import { freeDisposableCaches } from './storageCaches';

export { freeDisposableCaches, isDisposableCacheKey } from './storageCaches';

export const WEB_TAB_LOCK = 'bwx-web-active';
export const WEB_TAB_TAKEOVER_LOCK = 'bwx-web-takeover';
export const WEB_TAB_MARKER_LOCK_PREFIX = 'bwx-web-tab:';
export const WEB_TAB_OWNER_KEY = 'bwx.web.activeTab';
export const WEB_TAB_TAKEOVER_KEY = 'bwx.web.takeover';
export const WEB_TAB_FLUSH_KEY = 'bwx.web.handedOver';
export const WEB_TAB_CHANNEL = 'bwx-web-tab';
export const MOVED_ERROR = 'bWalletX is open in another tab';
/** How long the old tab lets a running payment finish before it hands over anyway. */
export const PAYMENT_HANDOVER_WAIT_MS = 20_000;
/** After the payments: how long storage must be quiet before the hub is fenced, and the cap on that wait. */
export const QUIET_MS = 500;
export const QUIET_CAP_MS = 3000;

/**
 * storage.local keys re-read from localStorage on every get/set in the web wallet (Hub freshLocalKeys), so a
 * read-merge-write of the key material always merges onto what is stored now, never onto a copy from start-up.
 */
export const WEB_FRESH_KEYS: ReadonlySet<string> = new Set([
  'accounts',
  'salt',
  'keyRekey',
  'keyEpoch',
  'keyRecovery',
  'kdfPending',
]);
export const isFreshWebKey = (key: string) => WEB_FRESH_KEYS.has(key);

/** The parts of navigator.locks used here. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string; clientId?: string }> }>;
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
  /** localStorage is full: drop caches that are fetched again anyway. Returns how many items were removed. */
  freeSpace?: () => number;
  newId: () => string;
  now: () => number;
  /** First load: retry the lock after these waits before showing the screen (a reload races the old page). */
  claimRetryMs?: number[];
  /** How long "Use here instead" waits for the active tab to let go before taking the lock anyway. */
  takeoverWaitMs?: number;
  /** After "a payment is finishing", how long the new tab keeps waiting. */
  busyWaitMs?: number;
  /** How long it waits for the old tab's last writes to be visible here. */
  flushWaitMs?: number;
  /** Cap on the old tab's release (payment wait + flush). */
  releaseWaitMs?: number;
  /** How long a released tab waits to be replaced before it gives the lock back and reloads. */
  stealWaitMs?: number;
  /** No Web Locks: how long a fresh claim waits before checking no other tab claimed at the same moment. */
  claimSettleMs?: number;
}

type Msg =
  | { t: 'takeover'; from: string }
  | { t: 'busy'; by: string; to: string; reason: 'payment' | 'saving' }
  | { t: 'released'; by: string; to: string; marker: string };

export type WebTabState = 'inactive' | 'active' | 'releasing' | 'lost';
/** Why this tab is not the active one: the screen says which. */
export type WebTabBlock = 'other-tab' | 'storage-full' | 'no-storage' | 'busy';
export type HandoverProgress = 'payment';

type OwnerRecord = { id: string; at: number };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WebTab {
  readonly id: string;
  state: WebTabState = 'inactive';
  /** Set when claim/takeOver returns false. */
  blocked?: WebTabBlock;
  /** Locks mode: the owner record could not be written (localStorage full); retried on later writes. */
  recordPending = false;
  private channel?: ChannelLike;
  private releaseHook: (tell: (p: HandoverProgress) => void, stolen: boolean) => Promise<void> = async () => undefined;
  /** The query() fence: 'unknown' until the self-check after the claim; 'off' falls back to the owner record. */
  queryFence: 'unknown' | 'on' | 'off' = 'unknown';
  private myClientId?: string;
  private lostHooks: Array<() => void> = [];
  private letGo?: () => void;
  private waiters = new Set<(m: Msg) => void>();
  private released?: Promise<void>;
  private handingOver = false;
  private activatedAt = 0;
  private marker?: Promise<boolean>;
  private lastWriteFull = false;

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

  private get markerName() {
    return WEB_TAB_MARKER_LOCK_PREFIX + this.id;
  }

  /**
   * main.ts, once its hub and worker exist: let a running payment finish (calling `tell('payment')` first), fence
   * the hub, flush its writes and stop the worker.
   */
  onRelease(fn: (tell: (p: HandoverProgress) => void, stolen: boolean) => Promise<void>) {
    this.releaseHook = fn;
  }

  /** main.ts: another tab has the wallet now (reload into the inactive screen). */
  onLost(fn: () => void) {
    this.lostHooks.push(fn);
  }

  /** At boot: become the active tab if no other tab is. Never waits for another tab (beyond a short retry). */
  async claim(): Promise<boolean> {
    this.blocked = undefined;
    if (!this.env.storage) return this.block('no-storage');
    if (this.env.locks) {
      for (const wait of [0, ...(this.env.claimRetryMs ?? [100, 250, 500])]) {
        if (wait) await sleep(wait);
        if (await this.claimWithLock(false)) return true;
      }
      return this.block('other-tab');
    }
    const r = await this.claimByRecord(false);
    return r === 'ok' ? true : this.block(r === 'full' ? 'storage-full' : 'other-tab');
  }

  /** "Use here instead": ask the active tab to finish, flush, stop and let go, then take over. */
  async takeOver(onProgress?: (p: HandoverProgress) => void): Promise<boolean> {
    if (this.state === 'active') return true;
    this.blocked = undefined;
    if (!this.env.storage) return this.block('no-storage');
    this.state = 'inactive';
    // One takeover at a time: a second tab pressing at the same moment is told to try again (no flip-flop).
    const done = await this.takeoverIntent();
    if (!done) return this.block('busy');
    try {
      return await this.takeOverNow(onProgress);
    } finally {
      done();
    }
  }

  /**
   * The write fence (fencedBackend): true only while this tab still holds the wallet. With Web Locks the browser is
   * asked (query); a lock another tab holds now retires this tab. Anything it can't confirm refuses the write.
   */
  async stillOwner(): Promise<boolean> {
    if (this.state !== 'active') return false;
    const locks = this.env.locks;
    if (locks) {
      if (this.queryFence === 'unknown') await this.selfCheck();
      if (this.queryFence === 'on') {
        const verdict = await this.queryVerdict();
        if (verdict === 'mine') {
          if (this.recordPending) this.recordPending = !this.writeOwner();
          return true;
        }
        if (verdict === 'other-tab') {
          this.lose();
          return false;
        }
        if (verdict === 'unsure') return false; // refuse this write (the next one asks again); never retire on it
        // 'unusable': fall through to the owner record.
      }
      // No query(): only an owner record newer than this tab's own start means another tab took over.
      const rec = this.readRecordSafe();
      if (rec === undefined) return false;
      if (rec && rec.id !== this.id && rec.at >= this.activatedAt) {
        this.lose();
        return false;
      }
      if (!rec || rec.id !== this.id) this.recordPending = !this.writeOwner();
      return true;
    }
    // No Web Locks: the record is the election.
    const rec = this.readRecordSafe();
    if (rec === undefined) return false;
    if (rec?.id === this.id) return true;
    if (rec === null) return this.writeOwner(); // cleared under us (site data): we still hold the claim
    this.lose();
    return false;
  }

  /** pagehide: without Web Locks, a closing active tab clears its record so the next tab starts by itself. */
  onPageHide() {
    if (this.env.locks || this.state !== 'active') return;
    try {
      if (this.readRecord()?.id === this.id) this.env.storage?.removeItem(WEB_TAB_OWNER_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  // INTERNALS ***************************************************************

  private block(reason: WebTabBlock): false {
    this.blocked = reason;
    return false;
  }

  private async takeOverNow(onProgress?: (p: HandoverProgress) => void): Promise<boolean> {
    // Nobody has it (the other tab closed): take it straight away.
    if (this.env.locks) {
      if (await this.claimWithLock(false)) return true;
    } else if (this.readRecordSafe() === null) {
      const r = await this.claimByRecord(false);
      if (r === 'ok') return true;
      if (r === 'full') return this.block('storage-full');
    }

    let deadline = this.env.now() + (this.env.takeoverWaitMs ?? 3000);
    const answers: Msg[] = [];
    let wake: () => void = () => undefined;
    const waiter = (m: Msg) => {
      if ((m.t === 'released' || m.t === 'busy') && m.to === this.id) {
        answers.push(m);
        wake();
      }
    };
    this.waiters.add(waiter);
    let released: Extract<Msg, { t: 'released' }> | undefined;
    try {
      this.channel?.postMessage({ t: 'takeover', from: this.id } satisfies Msg);
      while (!released) {
        const left = deadline - this.env.now();
        if (left <= 0) break;
        if (answers.length === 0)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, left);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        for (const m of answers.splice(0)) {
          if (m.t === 'released') released = m;
          else if (m.t === 'busy') {
            // A payment is finishing there: keep waiting for it rather than cutting it off.
            if (m.reason === 'payment') onProgress?.('payment');
            deadline = Math.max(
              deadline,
              this.env.now() + (this.env.busyWaitMs ?? PAYMENT_HANDOVER_WAIT_MS + QUIET_CAP_MS + 5000),
            );
          }
        }
      }
    } finally {
      this.waiters.delete(waiter);
    }
    // The old tab flushed: start only once its last write is visible here, or the hub would load a stale copy.
    if (released && released.marker && !(await this.markerVisible(released.marker))) return this.block('other-tab');
    if (released && !released.marker) await sleep(Math.min(250, this.env.flushWaitMs ?? 3000));
    // No answer: the old tab is frozen, hung or gone. Take it anyway; the fence refuses its later writes.
    if (this.env.locks) return (await this.claimWithLock(true)) || this.block('other-tab');
    const r = await this.claimByRecord(true);
    return r === 'ok' ? true : this.block(r === 'full' ? 'storage-full' : 'other-tab');
  }

  /** A lock (or, without Web Locks, a short-lived record) held while this tab takes over. null: another tab is. */
  private async takeoverIntent(): Promise<(() => void) | null> {
    const locks = this.env.locks;
    if (locks) {
      return new Promise((resolve) => {
        locks
          .request(WEB_TAB_TAKEOVER_LOCK, { ifAvailable: true }, (lock) => {
            if (!lock) return resolve(null);
            return new Promise<void>((done) => resolve(() => done()));
          })
          .catch(() => resolve(null));
      });
    }
    const storage = this.env.storage!;
    try {
      const raw = storage.getItem(WEB_TAB_TAKEOVER_KEY);
      const other = raw ? (JSON.parse(raw) as OwnerRecord) : null;
      if (other && other.id !== this.id && this.env.now() - other.at < 30_000) return null;
      storage.setItem(WEB_TAB_TAKEOVER_KEY, JSON.stringify({ id: this.id, at: this.env.now() }));
    } catch {
      return () => undefined; // can't record the intent (full storage): carry on without it
    }
    return () => {
      try {
        const raw = storage.getItem(WEB_TAB_TAKEOVER_KEY);
        if (raw && (JSON.parse(raw) as OwnerRecord).id === this.id) storage.removeItem(WEB_TAB_TAKEOVER_KEY);
      } catch {
        /* expires by itself */
      }
    };
  }

  /**
   * Once, after the claim: can query() tell this page apart from other clients? Usable only when the marker lock and
   * the wallet lock report the same, non-empty clientId, and no other tab's marker shares it. Otherwise (browsers that
   * report a different clientId per lock, an empty one, or the same one for every client) the query fence is turned
   * off and the owner record is used: a clientId mismatch alone must never retire a tab (re-review, clientId cases).
   */
  private async selfCheck() {
    const locks = this.env.locks;
    if (!locks?.query || !(await this.marker)) {
      this.queryFence = 'off';
      return;
    }
    let held: Array<{ name?: string; clientId?: string }>;
    try {
      held = (await locks.query()).held ?? [];
    } catch {
      return; // stays 'unknown': this write uses the owner record, the next one checks again
    }
    const me = held.find((l) => l.name === this.markerName)?.clientId;
    const holder = held.find((l) => l.name === WEB_TAB_LOCK)?.clientId;
    const sharedWithAnotherTab = this.otherMarkers(held).some((l) => l.clientId === me);
    const usable = typeof me === 'string' && me !== '' && holder === me && !sharedWithAnotherTab;
    this.queryFence = usable ? 'on' : 'off';
    this.myClientId = usable ? me : undefined;
  }

  private otherMarkers(held: Array<{ name?: string; clientId?: string }>) {
    return held.filter((l) => l.name?.startsWith(WEB_TAB_MARKER_LOCK_PREFIX) && l.name !== this.markerName);
  }

  /**
   * The browser's answer: 'mine' (this page holds the wallet lock), 'other-tab' (positive evidence: another tab's
   * marker shares the holder's clientId), 'unsure' (refuse this write, keep the tab), or 'unusable' (fall back).
   */
  private async queryVerdict(): Promise<'mine' | 'other-tab' | 'unsure' | 'unusable'> {
    let held: Array<{ name?: string; clientId?: string }>;
    try {
      held = (await this.env.locks!.query!()).held ?? [];
    } catch {
      return 'unsure';
    }
    if (this.state !== 'active') return 'unsure';
    const me = held.find((l) => l.name === this.markerName)?.clientId;
    const holder = held.find((l) => l.name === WEB_TAB_LOCK)?.clientId;
    const others = this.otherMarkers(held);
    if (me !== this.myClientId || others.some((l) => l.clientId === me)) {
      // This page's id changed or another tab reports the same one: the fence can't tell tabs apart any more.
      this.queryFence = 'off';
      return 'unusable';
    }
    if (holder === me) return 'mine';
    if (holder !== undefined && holder !== '' && others.some((l) => l.clientId === holder)) return 'other-tab';
    return 'unsure';
  }

  /** A lock only this tab holds, so query() can tell which client holds the wallet lock. */
  private holdMarker(): Promise<boolean> {
    const locks = this.env.locks;
    if (!locks?.query) return Promise.resolve(false);
    this.marker ??= new Promise<boolean>((resolve) => {
      locks
        .request(this.markerName, {}, (lock) => {
          resolve(!!lock);
          return lock ? new Promise<void>(() => undefined) : undefined;
        })
        .catch(() => resolve(false));
    });
    return this.marker;
  }

  private claimWithLock(steal: boolean): Promise<boolean> {
    const locks = this.env.locks!;
    return this.holdMarker().then(
      () =>
        new Promise<boolean>((resolve) => {
          let held = false;
          locks
            .request(WEB_TAB_LOCK, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
              if (!lock) return resolve(false);
              // The held lock is the authority: a full localStorage only delays the owner record.
              held = true;
              this.activatedAt = this.env.now();
              this.state = 'active';
              this.recordPending = !this.writeOwner();
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
        }),
    );
  }

  private async claimByRecord(force: boolean): Promise<'ok' | 'other' | 'full'> {
    try {
      if (!force && this.readRecord() !== null) return 'other'; // another tab's record, however old: inactive
    } catch {
      return 'other';
    }
    if (!this.writeOwner()) return this.lastWriteFull ? 'full' : 'other';
    await sleep(this.env.claimSettleMs ?? 300);
    if (this.readRecordSafe()?.id !== this.id) return 'other'; // another tab claimed at the same moment
    this.activatedAt = this.env.now();
    this.state = 'active';
    return 'ok';
  }

  /** Write the owner record; on a full localStorage, drop known caches and try once more. */
  private writeOwner(): boolean {
    const value = JSON.stringify({ id: this.id, at: this.env.now() } satisfies OwnerRecord);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.env.storage!.setItem(WEB_TAB_OWNER_KEY, value);
        this.lastWriteFull = false;
        return this.readRecordSafe()?.id === this.id;
      } catch (e) {
        this.lastWriteFull = isQuota(e);
        if (!this.lastWriteFull || attempt > 0) return false;
        try {
          if (!this.env.freeSpace || this.env.freeSpace() === 0) return false;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  /** The owner record, null when there is none, a foreign '?' record when it can't be parsed. Throws if unreadable. */
  private readRecord(): OwnerRecord | null {
    const raw = this.env.storage!.getItem(WEB_TAB_OWNER_KEY);
    if (raw === null) return null;
    try {
      const r = JSON.parse(raw) as Partial<OwnerRecord>;
      return typeof r.id === 'string' && r.id
        ? { id: r.id, at: typeof r.at === 'number' ? r.at : Number.MAX_SAFE_INTEGER }
        : { id: '?', at: Number.MAX_SAFE_INTEGER };
    } catch {
      return { id: '?', at: Number.MAX_SAFE_INTEGER };
    }
  }

  private readRecordSafe(): OwnerRecord | null | undefined {
    try {
      return this.readRecord();
    } catch {
      return undefined;
    }
  }

  private checkOwner() {
    if (this.state !== 'active' && this.state !== 'releasing') return;
    const rec = this.readRecordSafe();
    if (!rec || rec.id === this.id) return;
    // With Web Locks the lock decides; a record only counts when it is newer than this tab's start.
    if (this.env.locks && rec.at < this.activatedAt) return;
    this.lose();
  }

  private onMessage(data: unknown) {
    const m = data as Msg;
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    for (const w of [...this.waiters]) w(m);
    if (m.t === 'takeover' && m.from !== this.id && this.state === 'active') void this.handOver(m.from);
  }

  private runRelease(tell: (p: HandoverProgress) => void = () => undefined): Promise<void> {
    this.released ??= Promise.race([
      this.releaseHook(tell, false).catch(() => undefined),
      sleep(this.env.releaseWaitMs ?? PAYMENT_HANDOVER_WAIT_MS + QUIET_CAP_MS + (this.env.flushWaitMs ?? 3000)),
    ]);
    return this.released;
  }

  /** Another tab asked for the wallet: finish a payment, fence, flush, stop, mark, answer; then wait to be replaced. */
  private async handOver(to: string) {
    if (this.handingOver) return; // a second asker gets no answer (and is held back by the takeover lock)
    this.handingOver = true;
    // Tell the new tab at once that this tab is finishing its writes, so it waits instead of taking over after 3 s.
    this.channel?.postMessage({ t: 'busy', by: this.id, to, reason: 'saving' } satisfies Msg);
    // Still 'active' while the hook runs: the hub is fenced (no new writes), and the writes it already accepted
    // must still pass the owner check on their way to localStorage.
    await this.runRelease((reason) => this.channel?.postMessage({ t: 'busy', by: this.id, to, reason } satisfies Msg));
    if (this.state !== 'active') return; // stolen meanwhile
    this.state = 'releasing';
    let marker = `${this.id}:${this.env.now()}`;
    try {
      this.env.storage?.setItem(WEB_TAB_FLUSH_KEY, marker);
    } catch {
      marker = ''; // localStorage full: no marker; the new tab gives the writes a moment instead
    }
    this.channel?.postMessage({ t: 'released', by: this.id, to, marker } satisfies Msg);
    // The steal (Web Locks) or the new owner record (storage event) retires this tab; if neither comes (the other
    // tab closed meanwhile), give the lock back and reload, which makes this tab active again.
    setTimeout(() => this.lose(), this.env.stealWaitMs ?? 10_000);
  }

  private lose() {
    if (this.state === 'lost') return;
    const was = this.state;
    this.state = 'lost';
    // Retired: fence and stop the worker at once, like closing the tab: no payment wait, so the old worker never runs
    // beside the new tab's (re-review C). After a normal handover this only repeats what already happened.
    const stopped =
      was === 'inactive'
        ? Promise.resolve()
        : Promise.race([
            this.releaseHook(() => undefined, true).catch(() => undefined),
            sleep(this.env.flushWaitMs ?? 3000),
          ]);
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
export const fencedBackend = <B extends LocalBackend>(backend: B, tab: Pick<WebTab, 'stillOwner'>): B => ({
  ...backend,
  apply: async (sets: Record<string, string>, removes: string[]) => {
    if (!(await tab.stillOwner())) throw new Error(MOVED_ERROR);
    return backend.apply(sets, removes);
  },
});

/** Payments running in this tab's worker (it posts { t: 'spends', n }): the release waits for them. */
export class SpendGauge {
  private n = 0;
  private idleWaiters = new Set<() => void>();

  get count() {
    return this.n;
  }

  set(n: number) {
    this.n = Number.isFinite(n) && n > 0 ? n : 0;
    if (this.n === 0) for (const w of [...this.idleWaiters]) w();
  }

  /** True once no payment is running; false when `ms` passed first. */
  idle(ms: number): Promise<boolean> {
    if (this.n === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        this.idleWaiters.delete(waiter);
        clearTimeout(timer);
        resolve(v);
      };
      const waiter = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.idleWaiters.add(waiter);
    });
  }
}

/**
 * The active tab's release (main.ts onRelease), in one place so the tests run the same steps:
 * - handover asked for: let a running payment finish (up to 20 s, the other tab is told), then wait for storage to go
 *   quiet (the payment's caller records its result right after it returns), then fence, flush and stop the worker;
 * - retired (stolen, or replaced): fence and stop the worker at once, like closing the tab.
 */
export const releaseWallet = async (p: {
  hub: { fence(): void; flush(): Promise<void>; quiet(quietMs: number, capMs: number): Promise<void> };
  spends: SpendGauge;
  stopWorker: () => void;
  tell: (progress: HandoverProgress) => void;
  stolen: boolean;
  paymentWaitMs?: number;
  quietMs?: number;
  quietCapMs?: number;
}) => {
  if (p.stolen) {
    p.hub.fence();
    p.stopWorker();
    await p.hub.flush();
    return;
  }
  if (p.spends.count > 0) {
    p.tell('payment');
    await p.spends.idle(p.paymentWaitMs ?? PAYMENT_HANDOVER_WAIT_MS);
  }
  await p.hub.quiet(p.quietMs ?? QUIET_MS, p.quietCapMs ?? QUIET_CAP_MS);
  p.hub.fence();
  await p.hub.flush();
  p.stopWorker();
};

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
  let storage: Storage | undefined;
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
    freeSpace: () => (storage ? freeDisposableCaches(storage) : 0),
    newId: () =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    now: () => Date.now(),
  };
};

const SCREEN_COPY: Record<Exclude<WebTabBlock, 'busy'>, { title: string; line: string; button: string }> = {
  'other-tab': {
    title: 'bWalletX is open in another tab',
    line: 'Your wallet runs in one tab at a time, so everything stays in step.',
    button: 'Use here instead',
  },
  'storage-full': {
    title: 'This browser’s storage for bWalletX is full',
    line: 'Please don’t clear this site’s data: your wallet’s keys are kept there. Free some space in your browser, then try again.',
    button: 'Try again',
  },
  'no-storage': {
    title: 'bWalletX can’t use this browser’s storage',
    line: 'Allow site data for this site in your browser settings (private windows may block it), then try again.',
    button: 'Try again',
  },
};

const FAILED_NOTE: Record<WebTabBlock, string> = {
  'other-tab': 'The other tab is still busy. Close it, or try again.',
  busy: 'Another tab is already moving the wallet. Try again in a moment.',
  'storage-full': 'Still full. Free some space, then try again.',
  'no-storage': 'Still blocked. Check the site data setting, then try again.',
};

/** The one screen an inactive tab shows. Plain DOM: no React, no hub. */
export const showInactiveScreen = (doc: Document, reason: WebTabBlock, onUse: () => void) => {
  const box = doc.createElement('div');
  box.id = 'bwallet-other-tab';
  box.setAttribute('role', 'main');
  box.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:16px;padding:24px 16px;background:#010101;color:#fff;text-align:center;' +
    'font:16px/1.4 Inter,system-ui,-apple-system,sans-serif';
  const title = doc.createElement('h1');
  title.style.cssText = 'margin:0;font-size:20px;font-weight:700;max-width:340px';
  const line = doc.createElement('p');
  line.style.cssText = 'margin:0;opacity:0.7;max-width:320px';
  const button = doc.createElement('button');
  button.type = 'button';
  button.style.cssText =
    'padding:12px 32px;border:0;border-radius:999px;background:#f5c518;color:#000;font:inherit;font-weight:700;' +
    'cursor:pointer';
  const note = doc.createElement('p');
  note.style.cssText = 'margin:0;font-size:13px;opacity:0.6;max-width:300px;min-height:18px';
  const show = (r: WebTabBlock) => {
    const copy = SCREEN_COPY[r === 'busy' ? 'other-tab' : r];
    title.textContent = copy.title;
    line.textContent = copy.line;
    button.textContent = copy.button;
  };
  show(reason);
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
    progress: (p: HandoverProgress) => {
      if (p === 'payment') note.textContent = 'Finishing a payment in the other tab…';
    },
    failed: (r: WebTabBlock) => {
      show(r);
      button.disabled = false;
      note.textContent = FAILED_NOTE[r];
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
    const screen = showInactiveScreen(doc, tab.blocked ?? 'other-tab', () => {
      // localStorage could not be opened at all: only a fresh page can try again.
      if (tab.blocked === 'no-storage' && typeof location !== 'undefined') return location.reload();
      void tab
        .takeOver((p) => screen.progress(p))
        .then((ok) => {
          if (!ok) return screen.failed(tab.blocked ?? 'other-tab');
          screen.remove();
          resolve();
        });
    });
  });
  return tab;
};
