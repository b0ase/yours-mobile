import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { applyAtomically } from './atomicStorage';
import { YoursNative } from './native';
import { freeDisposableCaches } from './storageCaches';
import type { HostOp, Sender, StorageArea, StorageChanges, ToEndpoint, ToHub } from './protocol';

/**
 * The hub plays the part of the browser: it routes runtime messages and ports
 * between extension pages and owns chrome.storage.
 *
 * - storage.local is persisted in native secure storage (iOS Keychain,
 *   this-device-only and excluded from backups; Android Keystore-wrapped
 *   prefs) so the encrypted keystore survives WebView storage eviction.
 * - storage.session on phones is mirrored to the WebView's sessionStorage: it
 *   survives a location.reload() (as chrome.storage.session survives a popup
 *   reload) and is gone when the app process dies.
 * - storage.session on web and Desktop is memory only (`persistSession: false`).
 *   A desktop browser writes sessionStorage to the profile on disk for session
 *   restore, and the session holds the unlock key, so nothing from it may land
 *   there. A reload asks for the one-tap unlock again; with auto-lock "Never"
 *   the wallet stays open for the life of the page.
 */

type Endpoint = { post: (json: string) => void; sender: Sender };

type PendingSend = {
  from: string;
  reqId: number;
  awaiting: Set<string>;
  done: boolean;
};

const LOCAL_PREFIX = 'chrome.storage.local:';
const SESSION_KEY = 'chrome.storage.session';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';

export interface HubOptions {
  /** Mirror storage.session to sessionStorage so it survives a reload. Phones only; see the note above. */
  persistSession?: boolean;
  /**
   * storage.local keys that are re-read from the backend on every get/set instead of trusting this hub's in-memory
   * copy (web wallet, 13 Nov 2026). Each browser tab of the web wallet runs its own hub and background worker over the
   * same localStorage; a copy loaded once at start-up goes stale when another tab writes, and an envelope balance
   * read from a stale copy could be spent twice. Only used when the backend can read single keys (loadKeys).
   */
  freshLocalKeys?: (key: string) => boolean;
}

/** Read the persisted session mirror, or drop it when this edition keeps the session in memory. */
export const initialSession = (persist: boolean, store: Pick<Storage, 'getItem' | 'removeItem'>) => {
  try {
    if (!persist) {
      // Older builds mirrored the session (unlock key included) here; remove it.
      store.removeItem(SESSION_KEY);
      return new Map<string, unknown>();
    }
    return new Map<string, unknown>(
      Object.entries(JSON.parse(store.getItem(SESSION_KEY) ?? '{}') as Record<string, unknown>),
    );
  } catch {
    return new Map<string, unknown>();
  }
};

export type HostHandler = (op: HostOp, args: unknown[]) => Promise<unknown>;

/**
 * Where storage.local is persisted. Keys arrive already prefixed (LOCAL_PREFIX) and values JSON-encoded.
 * - Phones (default): YoursNative secure storage, one item per key.
 * - Desktop (Tauri): one owner-only file in the app data dir, written atomically per batch (desktop/storage.ts).
 */
export interface LocalBackend {
  load(): Promise<Record<string, string>>;
  apply(sets: Record<string, string>, removes: string[]): Promise<void>;
  /** Read these (prefixed) keys as stored right now; null = not stored. Optional: used for HubOptions.freshLocalKeys. */
  loadKeys?(keys: string[]): Promise<Record<string, string | null>>;
}

/** Builds before 5.1.0-mobile.2 kept storage.local in Preferences; move it into secure storage. */
const migrateFromPreferences = async () => {
  const { keys } = await Preferences.keys();
  for (const key of keys) {
    if (!key.startsWith(LOCAL_PREFIX)) continue;
    const { value } = await Preferences.get({ key });
    if (value !== null) await YoursNative.secureSet({ key, value });
    await Preferences.remove({ key });
  }
};

export const nativeLocalBackend: LocalBackend = {
  async load() {
    await migrateFromPreferences();
    const out: Record<string, string> = {};
    const { keys } = await YoursNative.secureKeys();
    for (const key of keys) {
      if (!key.startsWith(LOCAL_PREFIX)) continue;
      const { value } = await YoursNative.secureGet({ key });
      if (value !== null) out[key] = value;
    }
    return out;
  },
  async apply(sets, removes) {
    // Web (web.bwalletx.com): native.ts keeps these as `secure:` items in localStorage. Written all-or-nothing: a full
    // localStorage must never leave a new salt beside old accounts (a lockout; re-review R2). Phones: one Keychain /
    // Keystore item per key, as before (see the note in the review report).
    if (!Capacitor.isNativePlatform()) {
      return applyAtomically(localStorage, sets, removes, {
        prefix: WEB_SECURE_PREFIX,
        freeSpace: () => freeDisposableCaches(localStorage),
      });
    }
    await Promise.all([
      ...Object.entries(sets).map(([key, value]) => YoursNative.secureSet({ key, value })),
      ...removes.map((key) => YoursNative.secureRemove({ key })),
    ]);
  },
  async loadKeys(keys) {
    const out: Record<string, string | null> = {};
    for (const key of keys) out[key] = (await YoursNative.secureGet({ key })).value;
    return out;
  },
};

/** The prefix native.ts's web fallback puts on secure items in localStorage. */
export const WEB_SECURE_PREFIX = 'secure:';

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

export class Hub {
  private endpoints = new Map<string, Endpoint>();
  private pending = new Map<number, PendingSend>();
  private portOwners = new Map<string, string>();
  private nextHubReqId = 1;
  private local = new Map<string, unknown>();
  private session: Map<string, unknown>;
  private persistSession: boolean;
  private persistQueue: Promise<unknown> = Promise.resolve();
  private freshLocalKeys?: (key: string) => boolean;
  /** storage.local ops that touch a fresh key run one at a time: re-read, apply, persist (see onStorage). */
  private freshQueue: Promise<unknown> = Promise.resolve();
  private storageReady: Promise<void>;
  private fenced = false;
  /** storage.local values as last saved (loaded, re-read, or a write that went through): what a refused write restores. */
  private confirmed = new Map<string, unknown>();
  /** Per storage.local key: how many set/remove attempts it has had, no-ops included (rollback ownership, R1). */
  private writeSeq = new Map<string, number>();
  private backgroundReady: Promise<void>;
  private resolveBackgroundReady!: () => void;

  constructor(
    private host: HostHandler,
    private backend: LocalBackend = nativeLocalBackend,
    options: HubOptions = {},
  ) {
    this.persistSession = options.persistSession ?? true;
    this.freshLocalKeys = backend.loadKeys ? options.freshLocalKeys : undefined;
    this.session = initialSession(this.persistSession, sessionStorage);
    this.markUnlocked();
    this.storageReady = this.loadLocal();
    this.backgroundReady = new Promise((resolve) => (this.resolveBackgroundReady = resolve));
  }

  markBackgroundReady() {
    this.resolveBackgroundReady();
  }

  /**
   * Web wallet, another tab took over (webTab.ts): refuse every storage write from now on, so this tab's copy can
   * never be written back. Reads still answer while the page reloads.
   */
  fence() {
    this.fenced = true;
  }

  /** Resolves once every write already accepted has reached the backend (or failed). */
  async flush() {
    await this.persistQueue.catch(() => undefined);
  }

  /** Storage ops running now, and when the last one ended (quiet()). */
  private storageBusy = 0;
  private storageIdleSince = 0;

  /**
   * Resolves once no storage op has run for `quietMs` (or after `capMs`). Web one-tab handover: a payment's caller
   * records its result (outbox entry, grant hold, reservation) right after the payment returns; the hub is fenced only
   * once those writes have landed (re-review B).
   */
  async quiet(quietMs: number, capMs: number) {
    const until = Date.now() + capMs;
    for (;;) {
      const now = Date.now();
      if (now >= until) return;
      if (this.storageBusy === 0 && now - this.storageIdleSince >= quietMs) return;
      await new Promise((r) => setTimeout(r, Math.min(50, quietMs)));
    }
  }

  /** Counts a storage op as running until it settles (quiet()). */
  private async tracked<T>(op: Promise<T>): Promise<T> {
    this.storageBusy++;
    try {
      return await op;
    } finally {
      this.storageBusy--;
      this.storageIdleSince = Date.now();
    }
  }

  register(id: string, endpoint: Endpoint) {
    this.endpoints.set(id, endpoint);
  }

  unregister(id: string) {
    if (!this.endpoints.delete(id)) return;
    for (const [hubReqId, pending] of this.pending) {
      if (pending.awaiting.delete(id)) this.settleIfExhausted(hubReqId, pending);
    }
    for (const [portId, owner] of this.portOwners) {
      if (owner === id) {
        this.portOwners.delete(portId);
        this.broadcast({ t: 'portDisconnect', portId }, id);
      }
    }
  }

  /**
   * Broadcast to every endpoint except `except`. One endpoint that throws (a detached frame) never stops the others or
   * the caller: a storage reply after it must still be sent (review of fix/envelope-queue, F1).
   */
  broadcast(msg: ToEndpoint, except?: string) {
    const json = JSON.stringify(msg);
    for (const [id, endpoint] of this.endpoints) {
      if (id === except) continue;
      try {
        endpoint.post(json);
      } catch (error) {
        console.warn('[hub] endpoint post failed:', id, error);
      }
    }
  }

  handle = async (from: string, msg: ToHub) => {
    switch (msg.t) {
      case 'send':
        // In Chrome a message wakes the service worker; here we hold it until
        // the background has registered its listeners.
        await this.backgroundReady;
        return this.routeSend(from, msg.reqId, msg.message);
      case 'deliverResult':
        return this.onDeliverResult(from, msg);
      case 'lateResponse': {
        const pending = this.pending.get(msg.hubReqId);
        if (pending && !pending.done) this.finish(msg.hubReqId, pending, { response: msg.response });
        return;
      }
      case 'storage':
        return this.tracked(this.onStorage(from, msg));
      case 'connect':
        this.portOwners.set(msg.portId, from);
        await this.backgroundReady;
        return this.broadcast(
          { t: 'connect', portId: msg.portId, name: msg.name, sender: this.endpoints.get(from)!.sender },
          from,
        );
      case 'portPost':
        return this.broadcast({ t: 'portPost', portId: msg.portId, msg: msg.msg }, from);
      case 'portDisconnect':
        this.portOwners.delete(msg.portId);
        return this.broadcast({ t: 'portDisconnect', portId: msg.portId }, from);
      case 'host':
        try {
          const result = await this.host(msg.op, msg.args);
          return this.send(from, { t: 'hostResult', reqId: msg.reqId, result });
        } catch (error) {
          return this.send(from, { t: 'hostResult', reqId: msg.reqId, error: String(error) });
        }
    }
  };

  private send(to: string, msg: ToEndpoint) {
    try {
      this.endpoints.get(to)?.post(JSON.stringify(msg));
    } catch (error) {
      console.warn('[hub] endpoint post failed:', to, error);
    }
  }

  private routeSend(from: string, reqId: number, message: unknown) {
    const sender = this.endpoints.get(from)?.sender;
    if (!sender) return;
    const targets = [...this.endpoints.keys()].filter((id) => id !== from);
    if (targets.length === 0) {
      return this.send(from, { t: 'reply', reqId, error: NO_RECEIVER });
    }
    const hubReqId = this.nextHubReqId++;
    this.pending.set(hubReqId, { from, reqId, awaiting: new Set(targets), done: false });
    const json = JSON.stringify({ t: 'deliver', hubReqId, message, sender } satisfies ToEndpoint);
    for (const id of targets) this.endpoints.get(id)?.post(json);
  }

  private onDeliverResult(from: string, msg: Extract<ToHub, { t: 'deliverResult' }>) {
    const pending = this.pending.get(msg.hubReqId);
    if (!pending || pending.done) return;
    if (msg.hasResponse) return this.finish(msg.hubReqId, pending, { response: msg.response });
    if (!msg.keepOpen) {
      pending.awaiting.delete(from);
      this.settleIfExhausted(msg.hubReqId, pending);
    }
  }

  private settleIfExhausted(hubReqId: number, pending: PendingSend) {
    if (!pending.done && pending.awaiting.size === 0) this.finish(hubReqId, pending, { error: PORT_CLOSED });
  }

  private finish(hubReqId: number, pending: PendingSend, result: { response?: unknown; error?: string }) {
    pending.done = true;
    this.pending.delete(hubReqId);
    this.send(pending.from, { t: 'reply', reqId: pending.reqId, ...result });
  }

  // STORAGE ****************************************************************

  private async loadLocal() {
    for (const [key, value] of Object.entries(await this.backend.load())) {
      if (key.startsWith(LOCAL_PREFIX)) this.local.set(key.slice(LOCAL_PREFIX.length), JSON.parse(value));
    }
    this.confirmed = new Map(this.local);
  }

  private persist(ops: Array<[string, unknown]>) {
    const sets: Record<string, string> = {};
    const removes: string[] = [];
    for (const [key, value] of ops) {
      if (value === undefined) removes.push(LOCAL_PREFIX + key);
      else sets[LOCAL_PREFIX + key] = JSON.stringify(value);
    }
    this.persistQueue = this.persistQueue.then(() => this.backend.apply(sets, removes));
    return this.persistQueue;
  }

  /** An op over every key (get(null), clear): it may touch fresh keys only another tab has written so far. */
  private static allKeys(op: 'get' | 'set' | 'remove' | 'clear', arg: unknown): boolean {
    return op === 'clear' || (op === 'get' && (arg === null || arg === undefined));
  }

  /** The fresh keys (HubOptions.freshLocalKeys) a storage.local op reads or writes. */
  private freshKeysOf(op: 'get' | 'set' | 'remove' | 'clear', arg: unknown): string[] {
    const fresh = this.freshLocalKeys;
    if (!fresh) return [];
    let keys: string[];
    if (Hub.allKeys(op, arg) || arg === null || arg === undefined) keys = [...this.local.keys()];
    else if (typeof arg === 'string') keys = [arg];
    else if (Array.isArray(arg)) keys = arg.filter((k): k is string => typeof k === 'string');
    else keys = Object.keys(arg as Record<string, unknown>);
    return keys.filter((k) => fresh(k));
  }

  /**
   * Re-read fresh keys from the backend into this hub's copy, so another tab's write is seen. Throws when the backend
   * can't be read: the op fails (a payment is refused) rather than answering from a copy that may be stale.
   */
  private async refreshFresh(keys: string[]): Promise<StorageChanges> {
    const stored = await this.backend.loadKeys!(keys.map((k) => LOCAL_PREFIX + k));
    const changes: StorageChanges = {};
    for (const key of keys) {
      const raw = stored[LOCAL_PREFIX + key];
      const oldValue = this.local.get(key);
      if (raw === null || raw === undefined) {
        this.confirmed.delete(key);
        if (!this.local.has(key)) continue;
        this.local.delete(key);
        changes[key] = { oldValue };
        continue;
      }
      const value = JSON.parse(raw) as unknown;
      this.confirmed.set(key, value);
      if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
      this.local.set(key, value);
      changes[key] = oldValue === undefined ? { newValue: value } : { oldValue, newValue: value };
    }
    return changes;
  }

  private async onStorage(from: string, msg: Extract<ToHub, { t: 'storage' }>) {
    await this.storageReady;
    const local = msg.area === 'local';
    const all = local && !!this.freshLocalKeys && Hub.allKeys(msg.op, msg.arg);
    const fresh = local ? this.freshKeysOf(msg.op, msg.arg) : [];
    if (fresh.length === 0 && !all) return this.runStorageOp(from, msg);
    // Re-read, apply and persist in one queued step, so this tab's own writes land before its next re-read.
    const job = this.freshQueue.then(async () => {
      let seen: StorageChanges;
      try {
        // get(null) / clear: also the fresh keys another tab created after this hub loaded (review F6).
        const keys = all
          ? [
              ...new Set([
                ...fresh,
                ...Object.keys(await this.backend.load())
                  .filter((k) => k.startsWith(LOCAL_PREFIX))
                  .map((k) => k.slice(LOCAL_PREFIX.length))
                  .filter((k) => this.freshLocalKeys!(k)),
              ]),
            ]
          : fresh;
        seen = await this.refreshFresh(keys);
      } catch (error) {
        this.send(from, { t: 'storageResult', reqId: msg.reqId, error: String(error) });
        return;
      }
      // Another tab changed these keys: tell this tab's contexts (Chrome fires onChanged everywhere), in order, before
      // this op's own change. broadcast() never throws, so the reply below is always sent.
      if (Object.keys(seen).length > 0) this.broadcast({ t: 'storageChanged', area: 'local', changes: seen });
      await this.runStorageOp(from, msg);
    });
    this.freshQueue = job.catch(() => undefined);
    return job;
  }

  private async runStorageOp(from: string, msg: Extract<ToHub, { t: 'storage' }>) {
    const store = msg.area === 'local' ? this.local : this.session;
    if (this.fenced && msg.op !== 'get') {
      return this.send(from, { t: 'storageResult', reqId: msg.reqId, error: 'bWalletX is open in another tab' });
    }
    try {
      const { result, changes } = this.applyStorageOp(store, msg.op, msg.arg);
      if (msg.area === 'local' && changes) {
        // Every key's attempt count as this op left it: a later attempt on the key (even a no-op) owns it from then.
        const seqAt = new Map(Object.keys(changes).map((k) => [k, this.writeSeq.get(k) ?? 0]));
        try {
          const write = this.persist(Object.entries(changes).map(([key, change]) => [key, change.newValue]));
          // The queue never holds a failure: one refused write (the one-tab fence could not confirm, a full
          // localStorage) must not fail every later write until a reload (re-review A). This write still fails.
          this.persistQueue = write.catch(() => undefined);
          await write;
          // Saved: writes reach the backend in queue order, so these are now the stored values.
          for (const [key, change] of Object.entries(changes)) {
            if (change.newValue === undefined) this.confirmed.delete(key);
            else this.confirmed.set(key, change.newValue);
          }
        } catch (error) {
          // Not saved (and the backend wrote none of it): put this hub's copy back to what is stored, for every key
          // no later op has touched since (re-review R1: a later identical set owns the key and persists it itself).
          for (const key of Object.keys(changes)) {
            if ((this.writeSeq.get(key) ?? 0) !== seqAt.get(key)) continue;
            if (this.confirmed.has(key)) store.set(key, this.confirmed.get(key));
            else store.delete(key);
          }
          throw error;
        }
      } else if (changes) {
        if (this.persistSession) sessionStorage.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries(this.session)));
        this.markUnlocked();
      }
      this.send(from, { t: 'storageResult', reqId: msg.reqId, result });
      // Chrome fires onChanged in every context, the writer included.
      // A re-write of an unsaved value (applyStorageOp) is no change to the contexts: left out.
      const visible = changes
        ? Object.fromEntries(
            Object.entries(changes).filter(([, c]) => JSON.stringify(c.oldValue) !== JSON.stringify(c.newValue)),
          )
        : {};
      if (Object.keys(visible).length > 0) {
        this.broadcast({ t: 'storageChanged', area: msg.area as StorageArea, changes: visible });
      }
    } catch (error) {
      this.send(from, { t: 'storageResult', reqId: msg.reqId, error: String(error) });
    }
  }

  /** A yes/no (never the key) for the web build check, which must not reload an unlocked page by itself. */
  private markUnlocked() {
    try {
      (globalThis as { __bwxUnlocked?: boolean }).__bwxUnlocked = this.session.has('passKey');
    } catch {
      /* not in a page */
    }
  }

  private applyStorageOp(
    store: Map<string, unknown>,
    op: 'get' | 'set' | 'remove' | 'clear',
    arg: unknown,
  ): { result?: unknown; changes?: StorageChanges } {
    if (op === 'get') {
      const out: Record<string, unknown> = {};
      if (arg === null || arg === undefined) {
        for (const [key, value] of store) out[key] = value;
      } else if (typeof arg === 'string' || Array.isArray(arg)) {
        for (const key of typeof arg === 'string' ? [arg] : (arg as string[])) {
          if (store.has(key)) out[key] = store.get(key);
        }
      } else {
        for (const [key, fallback] of Object.entries(arg as Record<string, unknown>)) {
          out[key] = store.has(key) ? store.get(key) : fallback;
        }
      }
      return { result: out };
    }

    const changes: StorageChanges = {};
    const local = store === this.local;
    if (op === 'set') {
      for (const [key, raw] of Object.entries(clone(arg as Record<string, unknown>))) {
        const oldValue = store.get(key);
        if (raw === undefined) continue;
        if (local) this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
        // Same as this hub's copy: a no-op, unless that value isn't saved yet (an earlier write still going out, or
        // refused): then this set writes it too, so its "ok" is true even if the earlier write fails (re-review R1).
        if (JSON.stringify(oldValue) === JSON.stringify(raw)) {
          if (!local || JSON.stringify(this.confirmed.get(key)) === JSON.stringify(raw)) continue;
          changes[key] = { oldValue, newValue: raw };
          continue;
        }
        store.set(key, raw);
        changes[key] = oldValue === undefined ? { newValue: raw } : { oldValue, newValue: raw };
      }
    } else {
      const keys = op === 'clear' ? [...store.keys()] : typeof arg === 'string' ? [arg] : (arg as string[]);
      for (const key of keys) {
        if (local) this.writeSeq.set(key, (this.writeSeq.get(key) ?? 0) + 1);
        if (!store.has(key)) continue;
        changes[key] = { oldValue: store.get(key) };
        store.delete(key);
      }
    }
    return { changes };
  }
}
