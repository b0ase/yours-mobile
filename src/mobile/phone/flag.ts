import { useSyncExternalStore } from 'react';
import { WIDE_ON } from '../wide/flag';

/**
 * The phone layout (docs/PHONE-LAYOUT-PLAN.md) is the default since 5.1.83. Settings › Appearance › "Classic layout"
 * turns it off by storing '0' in localStorage['bwallet:phone-layout']; anything else (unset or '1') means on.
 * The switch also sets <html data-phone-layout>, which mobile.css uses for --dock-h.
 */
export const PHONE_LAYOUT_KEY = 'bwallet:phone-layout';
const EVENT = 'bwallet:phone-layout-changed';

export const phoneLayoutOn = (): boolean => {
  // The wide web layout has its own chrome (wide/WideShell.tsx): classic tabs underneath, hidden.
  if (WIDE_ON) return false;
  try {
    return localStorage.getItem(PHONE_LAYOUT_KEY) !== '0';
  } catch {
    return true;
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
    localStorage.setItem(PHONE_LAYOUT_KEY, on ? '1' : '0');
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

export const usePhoneLayout = () => useSyncExternalStore(subscribe, phoneLayoutOn, () => true);

/**
 * Round 8 (owner): app screens are one vertical Apps page with sticky section headers. The horizontal paging
 * track, dots and swipe (phone/pager.tsx, PhoneShell.tsx) stay in the code behind this flag for later.
 */
export const APPS_PAGED = false;
