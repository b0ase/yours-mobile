import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { loadUserApps, saveUserApps, type SavedApp } from '../names/paymail';

/**
 * Apps › Add app (owner, 5 Oct 2026): any website the user adds. Cached on the device per account and
 * kept on the paymail server under the wallet's identity key (signed), so restoring the 12 words on any
 * device brings the list back.
 */
const KEY = (id: string) => `bwallet.userApps.${id}`;
const f = (u: string, i?: RequestInit) => fetch(u, i);

const read = (id: string): SavedApp[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(id)) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const write = (id: string, apps: SavedApp[]) => {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(apps));
  } catch {
    /* storage unavailable */
  }
};

/** "zanaadu.com", "https://x.y/app" → a clean https URL, or null. */
export const normalizeAppUrl = (raw: string): string | null => {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (!u.hostname.includes('.')) return null;
    u.protocol = 'https:';
    return u.href;
  } catch {
    return null;
  }
};

export const appNameFromUrl = (url: string) => {
  const h = new URL(url).hostname.replace(/^www\./, '');
  const base = h.split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
};

/** A favicon for any site (no request to the site itself from our page). */
export const appIconFor = (url: string) => `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`;

export const useUserApps = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [apps, setApps] = useState<SavedApp[]>(() => (id ? read(id) : []));
  const [error, setError] = useState('');

  // On open: the server copy wins when it has anything (a restored wallet gets its apps back);
  // otherwise this device's list is uploaded.
  useEffect(() => {
    if (!id) return;
    let live = true;
    setApps(read(id));
    loadUserApps(f, apiContext.wallet)
      .then((remote) => {
        if (!live) return;
        if (remote.length) {
          write(id, remote);
          setApps(remote);
        } else if (read(id).length) void saveUserApps(f, apiContext.wallet, read(id)).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, apiContext.wallet]);

  const commit = (next: SavedApp[]) => {
    setApps(next);
    if (id) write(id, next);
    setError('');
    saveUserApps(f, apiContext.wallet, next).catch((e) =>
      setError(e instanceof Error ? `Saved on this device; backup failed: ${e.message}` : 'Backup failed'),
    );
  };

  const add = (raw: string, name?: string): string | null => {
    const url = normalizeAppUrl(raw);
    if (!url) return 'Enter a website, like zanaadu.com';
    if (apps.some((a) => a.url === url)) return 'Already in Your apps';
    commit([...apps, { url, name: (name || '').trim().slice(0, 40) || appNameFromUrl(url) }]);
    return null;
  };
  const remove = (url: string) => commit(apps.filter((a) => a.url !== url));

  return { apps, add, remove, error };
};
