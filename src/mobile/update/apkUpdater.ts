import { registerPlugin } from '@capacitor/core';

/**
 * ApkUpdate: android/app/src/direct/java/org/yours/wallet/ApkUpdatePlugin.java, registered only in the
 * direct flavour (MainActivity). The native side re-checks the URL (https, bwalletx.com) and the SHA-256.
 */
export type ApkUpdatePlugin = {
  /** Download to the app cache and hash it; rejects on a hash mismatch (the file is deleted). */
  download(o: { url: string; sha256: string; size: number }): Promise<{ sha256: string }>;
  /** Whether Android lets this app install packages ("Install unknown apps"). */
  canInstall(): Promise<{ allowed: boolean }>;
  /** Open Settings › Install unknown apps for this app. */
  openInstallSettings(): Promise<void>;
  /** Hand the verified APK to the package installer (Android shows its own confirm). */
  install(): Promise<void>;
  /** Open a bwalletx.com page in the phone's browser (the fallback download). */
  openSite(o: { url: string }): Promise<void>;
};

export const ApkUpdate = registerPlugin<ApkUpdatePlugin>('ApkUpdate');
