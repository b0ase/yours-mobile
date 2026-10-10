/**
 * Where an account's wallet data lives, and how its last sync went (owner, 10 Oct 2026: shown on the
 * "Settings for" card). Storage topology follows initWallet's resolveStorageConfig: activeRemote set → the
 * server holds the wallet's records; otherwise this device does, and any `remotes` are backups.
 */
import type { StorageConfig } from './types/chromeStorage.types';

export const SYNC_HEALTH_KEY = (identityAddress: string) => `syncHealth:${identityAddress}`;

export type SyncHealth = {
  status: 'complete' | 'error' | 'sweep-failed' | 'receive-failed' | 'arriving';
  at: number;
  error?: string;
  satoshis?: number;
};

export type StorageLabel = { title: string; detail: string; warn: boolean };

export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const nameOf = (host: string) => (host.endsWith('1sat.app') ? '1Sat' : host);

export function storageLabel(config: StorageConfig | undefined): StorageLabel {
  const remotes = config?.remotes ?? [];
  if (config?.activeRemote) {
    const host = hostOf(config.activeRemote);
    const backups = remotes.filter((r) => r !== config.activeRemote).map((r) => nameOf(hostOf(r)));
    return {
      title: `Stored on ${nameOf(host)} (${host})`,
      detail: backups.length ? `Backed up to ${backups.join(', ')}` : 'No backup copy',
      warn: false,
    };
  }
  if (remotes.length) {
    const names = remotes.map((r) => `${nameOf(hostOf(r))} (${hostOf(r)})`);
    return { title: 'Stored on this device', detail: `Backed up to ${names.join(', ')}`, warn: false };
  }
  return {
    title: 'Stored on this device only',
    detail: 'No backup copy: if this browser is cleared, restore from your 12 words',
    warn: true,
  };
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export type HealthLabel = { text: string; failing: boolean; error?: string };

export function syncHealthLabel(h: SyncHealth | undefined, now = Date.now()): HealthLabel {
  if (!h) return { text: 'Not synced yet on this device', failing: false };
  const when = ago(now - h.at);
  switch (h.status) {
    case 'complete':
      return { text: `Synced ${when}`, failing: false };
    case 'arriving':
      return { text: `Payment arriving (${h.satoshis ?? 0} sats), still being added · ${when}`, failing: false };
    default:
      return { text: `Sync failing: ${h.error || h.status} · ${when}`, failing: true, error: h.error || h.status };
  }
}
