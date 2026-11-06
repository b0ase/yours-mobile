/**
 * What network this device is on, for the weekly full pass's Wi-Fi rule (services/fullPass.ts).
 *  - A phone (Capacitor native): the Capacitor Network plugin when the app ships it, else the WebView's Network
 *    Information API (Android). true: Wi-Fi or ethernet; false: another network; undefined: can't tell (iOS without
 *    the plugin).
 *  - The web wallet and the extension: not a phone, so no Wi-Fi rule.
 */
import { Capacitor } from '@capacitor/core';

type NetworkPlugin = { getStatus(): Promise<{ connected?: boolean; connectionType?: string }> };

export const isPhone = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export async function onWifi(): Promise<boolean | undefined> {
  const plugin = (Capacitor as unknown as { Plugins?: { Network?: NetworkPlugin } }).Plugins?.Network;
  if (plugin && typeof plugin.getStatus === 'function') {
    try {
      const s = await plugin.getStatus();
      if (typeof s?.connectionType === 'string' && s.connectionType !== 'unknown')
        return s.connectionType === 'wifi' || s.connectionType === 'ethernet';
    } catch {
      // not available after all
    }
  }
  const type = (globalThis.navigator as { connection?: { type?: string } } | undefined)?.connection?.type;
  if (type === 'wifi' || type === 'ethernet') return true;
  if (type === 'cellular' || type === 'bluetooth' || type === 'wimax') return false;
  return undefined;
}
