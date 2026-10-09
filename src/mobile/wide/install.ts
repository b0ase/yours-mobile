import { useSyncExternalStore } from 'react';

/**
 * bWalletX Desktop as an installed app (owner, 9 Oct 2026): Chrome / Edge "Install app" gives it its own window,
 * dock icon and launcher entry, with nothing to sign or ship. Chrome offers it once via `beforeinstallprompt`;
 * keep that event (it fires early, so this module is imported by flag.ts before React mounts) and show an
 * Install button only while it's available and we are not already running installed.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const isInstalled = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: window-controls-overlay)').matches);

if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

export const canInstall = () => !!deferred && !isInstalled();

export async function installApp(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  emit();
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

export const useCanInstall = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    canInstall,
    () => false,
  );
