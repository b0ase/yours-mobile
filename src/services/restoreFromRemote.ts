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

export type StoreSummary = { outputs: number; spendableSats: number; actions: number };

type ListOutputs = (args: { basket: string; limit: number; offset: number }) => Promise<{
  totalOutputs: number;
  outputs: { satoshis: number; spendable: boolean }[];
}>;
type ListActions = (args: { labels: string[]; limit: number }) => Promise<{ totalActions: number }>;

/** What the ACTIVE store holds: default-basket outputs, their spendable sats, and actions. */
export async function summarizeActive(wallet: {
  listOutputs: ListOutputs;
  listActions: ListActions;
}): Promise<StoreSummary> {
  let outputs = 0;
  let spendableSats = 0;
  for (let offset = 0; ; offset += 1000) {
    const page = await wallet.listOutputs({ basket: 'default', limit: 1000, offset });
    outputs = page.totalOutputs;
    for (const o of page.outputs) if (o.spendable !== false) spendableSats += o.satoshis;
    if (page.outputs.length < 1000 || offset + 1000 >= page.totalOutputs) break;
  }
  const { totalActions } = await wallet.listActions({ labels: [], limit: 1 });
  return { outputs, spendableSats, actions: totalActions };
}

export const isEmpty = (s: StoreSummary) => s.outputs === 0 && s.actions === 0;

/** The device holds at least what the remote holds (it may hold more: its own unsynced work). */
export const covers = (local: StoreSummary, remote: StoreSummary) =>
  local.outputs >= remote.outputs && local.spendableSats >= remote.spendableSats && local.actions >= remote.actions;

export type SwitchDeps = {
  remoteUrl: string;
  /** Name of the active store's endpoint, undefined when the device's own store is active. */
  activeRemoteUrl: () => string | undefined;
  setActiveStorage: (target: 'local' | string) => Promise<void>;
  summarize: () => Promise<StoreSummary>;
  /** One more merge of the remote into the (now local) active store. */
  pullRemote: () => Promise<void>;
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
    remote = await d.summarize();
  } catch (e) {
    return backToRemote(`could not read the backup: ${String(e)}`);
  }
  log('[restore] backup holds', remote);

  // 2. Switch: the toolbox copies the remote into the device's store first.
  d.progress?.('Loading your wallet from backup… copying to this device');
  try {
    await d.setActiveStorage('local');
  } catch (e) {
    return backToRemote(`copy to this device failed: ${String(e)}`, remote);
  }

  // 3. Verify; one more pull if short.
  let local = await d.summarize().catch(() => undefined);
  if (!local || !covers(local, remote)) {
    log('[restore] device short after switch', local, 'pulling again');
    try {
      await d.pullRemote();
      local = await d.summarize();
    } catch (e) {
      return backToRemote(`second pull failed: ${String(e)}`, remote, local);
    }
  }
  if (!covers(local, remote)) return backToRemote('device still holds less than the backup', remote, local);
  log('[restore] device verified', local);
  return { ok: true, remote, local };
}
