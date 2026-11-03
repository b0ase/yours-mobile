/**
 * The app icon's number, on every surface from one function (setIconBadge):
 * - Phone (iOS / Android): the home-screen icon, via the in-repo AppBadge plugin (ios/App/App/AppBadgePlugin.swift,
 *   android/.../AppBadgePlugin.java). Owner, 3 Nov 2026: "the 'b' tile for my app on my iphone does NOT carry
 *   notification badges".
 * - Extension: the toolbar icon (chrome.action badge).
 * - Push server: the number is reported (setBadgeReporter, push/register.ts reportBadge) so pushes that arrive while
 *   the app is closed carry it as aps.badge / notification_count, plus the messages pushed since.
 *
 * The number is appIconTotal: unread chat (rooms + DMs, muted rooms left out) plus bMail (unread Inbox mail plus new
 * airdrops), i.e. the Chat and bMail tab badges added. The Feed's count is left out: new posts are not messages to you.
 * (Until 3 Nov 2026 the extension showed the bMail number alone, owner 26 Oct; it now shows the same total.)
 * Set by the open app / side panel, so it is the number as of the last time the app was open, plus pushes since.
 */
import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { IS_EXTENSION } from '../extension';

/** iOS shows any number; past this it is noise. */
export const BADGE_MAX = 9999;

/** A whole, non-negative, capped count (bad input is 0). */
export const clampBadge = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(BADGE_MAX, Math.floor(n)) : 0);

/** The app icon's number: the Chat tab's unread plus the bMail tab's count. */
export const appIconTotal = (chat: number, bmail: number): number => clampBadge(clampBadge(chat) + clampBadge(bmail));

/** '' clears the badge; above 99 shows "99+". */
export const iconBadgeText = (n: number): string =>
  !Number.isFinite(n) || n <= 0 ? '' : n > 99 ? '99+' : String(Math.floor(n));

type ActionApi = {
  setBadgeText(d: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor?(d: { color: string }): Promise<void> | void;
};

/**
 * Native side (AppBadgePlugin). `clearDelivered`: the count just went from some to none (everything was read), so
 * Android may remove the chat notifications still in the shade (its launcher badge comes from them). iOS ignores it.
 */
export type NativeBadge = { set(o: { count: number; clearDelivered: boolean }): Promise<unknown> };
const AppBadge = registerPlugin<NativeBadge>('AppBadge');

const defaultAction = (): ActionApi | undefined =>
  IS_EXTENSION ? (globalThis as { chrome?: { action?: ActionApi } }).chrome?.action : undefined;
const defaultNative = (): NativeBadge | undefined => (Capacitor.isNativePlatform() ? AppBadge : undefined);

let lastText: string | null = null;
let lastNative: number | null = null;
let current = 0;
/** The shell has no AppBadge plugin (UNIMPLEMENTED): stop asking. */
let nativeOff = false;
let resumeHooked = false;
let reporter: ((n: number, force: boolean) => void) | null = null;

/** Where the number is also sent (the push server). Set once by useTabBadges; null to stop. */
export const setBadgeReporter = (fn: ((n: number, force: boolean) => void) | null) => {
  reporter = fn;
};

const writeAction = (count: number, action: ActionApi | undefined) => {
  if (!action) return;
  const text = iconBadgeText(count);
  if (text === lastText) return;
  lastText = text;
  try {
    void Promise.resolve(action.setBadgeText({ text })).catch(() => undefined);
    if (text) void Promise.resolve(action.setBadgeBackgroundColor?.({ color: '#F04438' })).catch(() => undefined);
  } catch {
    /* no action API (not the extension) */
  }
};

const writeNative = (count: number, native: NativeBadge | undefined, force = false) => {
  if (!native || nativeOff) return;
  if (!force && count === lastNative) return;
  const clearDelivered = count === 0 && (lastNative ?? 0) > 0;
  lastNative = count;
  try {
    void Promise.resolve(native.set({ count, clearDelivered })).catch((e: unknown) => {
      if ((e as { code?: unknown } | null)?.code === 'UNIMPLEMENTED') nativeOff = true;
    });
  } catch {
    /* plugin missing */
  }
};

/**
 * Back from the background: a push may have changed the icon while the app was away (aps.badge = the server's guess).
 * Put the app's own number back and report it again; the counts then refresh and correct it if anything changed.
 */
const hookResume = () => {
  if (resumeHooked || !Capacitor.isNativePlatform()) return;
  resumeHooked = true;
  try {
    void App.addListener('resume', () => {
      writeNative(current, defaultNative(), true);
      reporter?.(current, true);
    }).catch(() => undefined);
  } catch {
    /* no App plugin */
  }
};

/** Set the app icon's number everywhere (0 clears it). Writes only on change. */
export const setIconBadge = (
  n: number,
  action: ActionApi | undefined = defaultAction(),
  native: NativeBadge | undefined = defaultNative(),
) => {
  const count = clampBadge(n);
  current = count;
  hookResume();
  writeAction(count, action);
  writeNative(count, native);
  reporter?.(count, false);
};

/** Test hook: forget everything written. */
export const resetIconBadge = () => {
  lastText = null;
  lastNative = null;
  current = 0;
  nativeOff = false;
};
