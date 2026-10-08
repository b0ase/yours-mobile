import type { SignInItem } from '../chat/api';

/**
 * Settings › Chat › Recent sign-ins (bit-sign GET /api/bitsign/me/sign-ins), opened from the
 * "New sign-in to bChat" push. A tap on the push asks for the screen; Settings opens it on mount
 * or right away if it is already showing.
 */
export const SIGNINS_OPEN_EVENT = 'bwallet:open-signins';
let pending = false;

export const requestSignIns = () => {
  pending = true;
  try {
    window.dispatchEvent(new Event(SIGNINS_OPEN_EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** True once per request: Settings calls it on mount and on the event. */
export const takeSignInsRequest = () => {
  const p = pending;
  pending = false;
  return p;
};

const DEVICE: Record<SignInItem['device'], string> = {
  'ios-app': 'iPhone app',
  'android-app': 'Android app',
  browser: 'Browser',
};

export const deviceName = (d: string) => DEVICE[d as SignInItem['device']] ?? 'Browser';

/** "Browser · new account" / "iPhone app" and "8 Oct, 14:05". */
export const signInRow = (s: SignInItem, locale?: string) => {
  const d = new Date(s.at);
  const when = Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(locale ?? 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return { title: `${deviceName(s.device)}${s.newAccount ? ' · new account' : ''}`, when };
};

/** Settings › Identity map, opened by a long-press on the wallet card's identity line. */
export const IDMAP_OPEN_EVENT = 'bwallet:open-idmap';
let idmapPending = false;

export const requestIdentityMap = () => {
  idmapPending = true;
  try {
    window.dispatchEvent(new Event(IDMAP_OPEN_EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** True once per request: Settings calls it on mount and on the event. */
export const takeIdentityMapRequest = () => {
  const p = idmapPending;
  idmapPending = false;
  return p;
};
