import { useSyncExternalStore } from 'react';

/**
 * Test switch for the phone layout (docs/PHONE-LAYOUT-PLAN.md). Default OFF: with it off the app is unchanged.
 * Turn on with Settings › Testing › "New phone layout", or localStorage['bwallet:phone-layout'] = '1'.
 * The switch also sets <html data-phone-layout>, which mobile.css uses for --dock-h.
 */
export const PHONE_LAYOUT_KEY = 'bwallet:phone-layout';
const EVENT = 'bwallet:phone-layout-changed';

export const phoneLayoutOn = (): boolean => {
  try {
    return localStorage.getItem(PHONE_LAYOUT_KEY) === '1';
  } catch {
    return false;
  }
};

const applyAttr = (on: boolean) => {
  try {
    if (on) document.documentElement.setAttribute('data-phone-layout', '');
    else document.documentElement.removeAttribute('data-phone-layout');
  } catch {
    /* no document (tests) */
  }
};
applyAttr(phoneLayoutOn());

export const setPhoneLayout = (on: boolean) => {
  try {
    if (on) localStorage.setItem(PHONE_LAYOUT_KEY, '1');
    else localStorage.removeItem(PHONE_LAYOUT_KEY);
  } catch {
    /* storage unavailable: stays as it was */
  }
  applyAttr(phoneLayoutOn());
  window.dispatchEvent(new Event(EVENT));
};

const subscribe = (fn: () => void) => {
  const onStorage = (e: StorageEvent) => e.key === PHONE_LAYOUT_KEY && fn();
  window.addEventListener(EVENT, fn);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener('storage', onStorage);
  };
};

export const usePhoneLayout = () => useSyncExternalStore(subscribe, phoneLayoutOn, () => false);
