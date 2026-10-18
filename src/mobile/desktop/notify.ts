import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

/**
 * Desktop (Tauri) notifications for notify/engine.ts: the same items the phones schedule with LocalNotifications,
 * shown by the OS through tauri-plugin-notification. Permission is asked at the same moments as on the phones.
 */
export type DesktopNote = { title: string; body: string };

export const desktopNotify = async (notes: DesktopNote[]) => {
  if (!(await isPermissionGranted())) return;
  for (const n of notes.slice(0, 5)) sendNotification({ title: n.title, body: n.body });
};

export const askDesktopNotifyPermission = async () => {
  if (!(await isPermissionGranted())) await requestPermission();
};
