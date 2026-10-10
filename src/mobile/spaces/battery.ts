/**
 * Android battery optimisation for live Spaces (owner, 10 Oct 2026: his Android dropped out of a
 * Space when the screen slept). The foreground service (SpaceSessionService) keeps the process up,
 * but Doze/OEM battery savers can still cut the network. On the first Space you start or join we ask
 * once — an explain sheet first ("Keep the Space running with the screen off"), then the system
 * "Allow / Deny" dialog (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS via SpaceSessionPlugin).
 * "Asked" is remembered per install so it never nags; Settings › Preferences re-opens it.
 */
import { Capacitor } from '@capacitor/core';
import { SpaceSession, type SpaceSessionPlugin } from './background';

export const BATTERY_ASKED_KEY = 'bwallet.spaces.batteryAsked.v1';
export const BATTERY_TITLE = 'Keep the Space running with the screen off';
export const BATTERY_TEXT =
  'Android can pause bWalletX to save battery when your screen turns off, which drops you out of the Space. Allow bWalletX to keep running and the Space carries on in your pocket.';

const os = () => {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
};

export const batteryAsked = (): boolean => {
  try {
    return localStorage.getItem(BATTERY_ASKED_KEY) === '1';
  } catch {
    return false;
  }
};
export const markBatteryAsked = () => {
  try {
    localStorage.setItem(BATTERY_ASKED_KEY, '1');
  } catch {
    /* no storage */
  }
};

/** Pure: show the explain sheet? Android only, not already exempt, never asked on this install. */
export const shouldAskBattery = (o: { os: string; ignoring: boolean; asked: boolean }) =>
  o.os === 'android' && !o.ignoring && !o.asked;

/** Is the app already exempt? Anything other than Android (or an old build without the method) counts as yes. */
export const isIgnoringBattery = async (
  plugin: SpaceSessionPlugin = SpaceSession,
  platform = os(),
): Promise<boolean> => {
  if (platform !== 'android') return true;
  try {
    return (await plugin.isIgnoringBatteryOptimizations()).ignoring;
  } catch (e) {
    console.warn('[spaces] battery check unavailable', e);
    return true;
  }
};

/** Should this Space ask now? (first live moment of any Space, once per install) */
export const needsBatteryAsk = async (plugin: SpaceSessionPlugin = SpaceSession, platform = os()) =>
  shouldAskBattery({ os: platform, ignoring: await isIgnoringBattery(plugin, platform), asked: batteryAsked() });

/** The system dialog. Marks "asked" whatever the answer. */
export const requestIgnoreBattery = async (plugin: SpaceSessionPlugin = SpaceSession) => {
  markBatteryAsked();
  try {
    await plugin.requestIgnoreBatteryOptimizations();
  } catch (e) {
    console.warn('[spaces] battery optimisation request failed', e);
  }
};
