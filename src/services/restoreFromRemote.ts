/**
 * Restore on a new device (incident 14 Oct 2026, $bug and dkg): the wallet's records live on the remote store
 * (wallet.1sat.app); the device's own IndexedDB starts empty.
 *
 * Before: background.preferLocalStorage flipped every remote-active wallet to local-active once, trusting the
 * toolbox's setActive to have copied the remote's records in, and persisted `localFirst` whatever came across.
 * After that nothing ever pulled from the remote again: it is a backup, and backups are only pushed TO. A pull that
 * came up short (timeout, a 1Sat error mid-way, a page the server didn't send) left an empty wallet for good.
 *
 * Now: the switch is verified. With the remote active we count what it holds, switch, count what the device holds,
 * pull once more if short, and switch BACK to the remote if the device still holds less. Nothing is ever deleted:
 * every step is a toolbox merge. The same routine repairs a device already stuck local-active and empty.
 */

import { withTimeout } from './restoreProgress';

export type StoreSummary = {
  outputs: number;
  spendableSats: number;
  actions: number;
  /** The spendable default-basket coins by outpoint ("txid.vout"), when the listing gave them. */
  coins?: string[];
};

type ListOutputs = (args: { basket: string; limit: number; offset: number }) => Promise<{
  totalOutputs: number;
  outputs: { satoshis: number; spendable: boolean; outpoint?: string }[];
}>;
type ListActions = (args: { labels: string[]; limit: number }) => Promise<{ totalActions: number }>;

/** What the ACTIVE store holds: default-basket outputs, their spendable sats, and actions. */
export async function summarizeActive(
  wallet: {
    listOutputs: ListOutputs;
    listActions: ListActions;
  },
  /** `callMs`: a deadline on each request (the backup's first read); `pageSize`: outputs per page. */
  o: { callMs?: number; pageSize?: number } = {},
): Promise<StoreSummary> {
  const page_ = o.pageSize ?? 1000;
  const bound = <T>(p: Promise<T>, what: string) => (o.callMs ? withTimeout(p, o.callMs, what) : p);
  let outputs = 0;
  let spendableSats = 0;
  const coins: string[] = [];
  for (let offset = 0; ; offset += page_) {
    const page = await bound(wallet.listOutputs({ basket: 'default', limit: page_, offset }), 'the wallet listing');
    outputs = page.totalOutputs;
    for (const o of page.outputs)
      if (o.spendable !== false) {
        spendableSats += o.satoshis;
        if (typeof o.outpoint === 'string') coins.push(normOutpoint(o.outpoint));
      }
    if (page.outputs.length < page_ || offset + page_ >= page.totalOutputs) break;
  }
  const { totalActions } = await bound(wallet.listActions({ labels: [], limit: 1 }), 'the wallet listing');
  return { outputs, spendableSats, actions: totalActions, coins };
}

export const isEmpty = (s: StoreSummary) => s.outputs === 0 && s.actions === 0;

/** The device holds at least what the remote holds (it may hold more: its own unsynced work). */
export const covers = (local: StoreSummary, remote: StoreSummary) =>
  local.outputs >= remote.outputs && local.spendableSats >= remote.spendableSats && local.actions >= remote.actions;

const normOutpoint = (o: string) => (o.length > 64 && o[64] === '_' ? `${o.slice(0, 64)}.${o.slice(65)}` : o);

/**
 * Which of these outpoints ("txid.vout") the device's store holds, in any state. The inbound check (services/
 * inboundSync.ts) may leave a coin not spendable (spent here, waiting on the chain, quarantined): it is on the device,
 * so it is not "missing" (review 16 F5, 16b R1). Read from the store itself, so it holds across restarts.
 */
type DeviceStorage = {
  getAuth(): Promise<{ userId?: number }>;
  runAsStorageProvider<T>(fn: (sp: never) => Promise<T>): Promise<T>;
};
export const outpointsOnDevice =
  (storage: DeviceStorage) =>
  async (outpoints: string[]): Promise<Set<string>> => {
    const { userId } = await storage.getAuth();
    return storage.runAsStorageProvider(async (sp: never) => {
      const store = sp as { findOutputs(a: unknown): Promise<unknown[]> };
      const have = new Set<string>();
      for (const op of outpoints) {
        const [txid, vout] = normOutpoint(op).split('.');
        const found = await store.findOutputs({ partial: { userId, txid, vout: Number(vout) }, noScript: true });
        if (found.length) have.add(op);
      }
      return have;
    });
  };

export type SwitchDeps = {
  remoteUrl: string;
  /** Name of the active store's endpoint, undefined when the device's own store is active. */
  activeRemoteUrl: () => string | undefined;
  setActiveStorage: (target: 'local' | string) => Promise<void>;
  summarize: () => Promise<StoreSummary>;
  /**
   * The backup's first read, with a page size and a deadline on each request (restoreProgress): its spendable total is
   * shown on the card at once (onPreview). Falls back to `summarize`.
   */
  summarizeBackup?: () => Promise<StoreSummary>;
  /** The backup's total, before the copy starts: display only (restoreProgress.ts), never spendable. */
  onPreview?: (remote: StoreSummary) => void;
  /** The copy is in and the coin checks are running. */
  onChecking?: () => void;
  /** Always last, whatever the outcome: the card goes back to the real balance. */
  onFinished?: () => void;
  /** One more merge of the remote into the (now local) active store. */
  pullRemote: () => Promise<void>;
  /** Which of these outpoints the device's store holds in any state (outpointsOnDevice). */
  deviceHolds?: (outpoints: string[]) => Promise<Set<string>>;
  /**
   * Work through what the inbound check left for the chain to settle (inboundSync.admitPending), right after each copy
   * (review 16c, C6). `pendingActions`: transactions the backup counts that the device still holds as failed while the
   * chain is asked (C4); they count as present, as held coins do.
   */
  admit?: () => Promise<{ pendingActions?: number } | undefined | void>;
  /** After a verified switch: e.g. a device-sync pull. */
  onSwitched?: () => void;
  progress?: (message: string) => void;
  log?: (...args: unknown[]) => void;
};

export type SwitchResult =
  | { ok: true; remote: StoreSummary; local: StoreSummary }
  | { ok: false; reason: string; remote?: StoreSummary; local?: StoreSummary; activeIsRemote: boolean };

/**
 * Make the device's store active only once it holds everything the remote holds. On any failure the remote is
 * (made) active again, so the wallet keeps showing the remote's records.
 */
export async function switchToLocalVerified(d: SwitchDeps): Promise<SwitchResult> {
  try {
    return await switchVerified(d);
  } finally {
    d.onFinished?.();
  }
}

async function switchVerified(d: SwitchDeps): Promise<SwitchResult> {
  const log = d.log ?? (() => undefined);
  const backToRemote = async (reason: string, remote?: StoreSummary, local?: StoreSummary): Promise<SwitchResult> => {
    log('[restore] staying on the backup store:', reason);
    try {
      if (d.activeRemoteUrl() !== d.remoteUrl) await d.setActiveStorage(d.remoteUrl);
    } catch (e) {
      log('[restore] could not make the backup active again:', e);
    }
    return { ok: false, reason, remote, local, activeIsRemote: d.activeRemoteUrl() === d.remoteUrl };
  };

  d.progress?.('Loading your wallet from backup…');
  // 1. The remote active: its counts are the target. A device already local-active flips (merge, never delete).
  try {
    if (d.activeRemoteUrl() !== d.remoteUrl) await d.setActiveStorage(d.remoteUrl);
  } catch (e) {
    // Remote unreachable: nothing changed on the device; leave things as they are.
    log('[restore] backup store unreachable:', e);
    return {
      ok: false,
      reason: `backup unreachable: ${String(e)}`,
      activeIsRemote: d.activeRemoteUrl() === d.remoteUrl,
    };
  }
  let remote: StoreSummary;
  try {
    remote = await (d.summarizeBackup ?? d.summarize)();
  } catch (e) {
    return backToRemote(`could not read the backup: ${String(e)}`);
  }
  log('[restore] backup holds', remote);
  // Shown on the card before the copy starts (display only: nothing here spends or selects from it).
  try {
    d.onPreview?.(remote);
  } catch {
    /* a display problem never stops the restore */
  }

  // 2. Switch: the toolbox copies the remote into the device's store first.
  /**
   * Is the device's copy complete? The counts cover the backup's, or (when the counts fall short only because the
   * inbound check held coins back) every coin the backup holds as spendable is on the device in some state.
   */
  let heldActions = 0;
  const admit = async () => {
    const r = await d.admit?.().catch((e: unknown) => log('[restore] inbound admissions not worked through:', e));
    heldActions = (r && r.pendingActions) || 0;
  };
  const complete = async (found: StoreSummary): Promise<boolean> => {
    const local = { ...found, actions: found.actions + heldActions };
    if (covers(local, remote)) return true;
    if (!remote.coins || !d.deviceHolds || local.actions < remote.actions) return false;
    const have = await d.deviceHolds(remote.coins).catch(() => new Set<string>());
    const missing = remote.coins.filter((c) => !have.has(c));
    if (!missing.length) log('[restore] every backup coin is on the device; some are held back by the inbound check');
    return missing.length === 0;
  };
  d.progress?.('Loading your wallet from backup… copying to this device');
  try {
    await d.setActiveStorage('local');
  } catch (e) {
    return backToRemote(`copy to this device failed: ${String(e)}`, remote);
  }

  // 3. Verify; one more pull if short.
  d.onChecking?.();
  await admit();
  let local = await d.summarize().catch(() => undefined);
  if (!local || !(await complete(local))) {
    log('[restore] device short after switch', local, 'pulling again');
    try {
      await d.pullRemote();
      await admit();
      local = await d.summarize();
    } catch (e) {
      return backToRemote(`second pull failed: ${String(e)}`, remote, local);
    }
  }
  if (!(await complete(local))) return backToRemote('device still holds less than the backup', remote, local);
  log('[restore] device verified', local);
  d.onSwitched?.();
  return { ok: true, remote, local };
}
