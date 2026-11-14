import { createContext, useContext } from 'react';
import type { ScreenId } from './screens';

/** Shared by the phone layout's pager (pager.tsx, PhoneShell.tsx) and TopNav. */

/** True for a phone-layout page that is mounted but not on screen (phone/pager.tsx): no TopNav, no bApp frame. */
export const PeekContext = createContext(false);
export const useInPeek = () => useContext(PeekContext);

let pageEl: HTMLDivElement | null = null;
export const setPageEl = (el: HTMLDivElement | null) => {
  pageEl = el;
};
/** The element holding the routed page (null while the phone layout is off). */
export const getPageEl = () => pageEl;

/** False until the phone layout's cold start has landed on Home (PhoneShell): the Wallet route a fresh unlock
 *  opens on is not kept mounted behind Home (it would load in the background and slow the start). */
let landedFlag = false;
/**
 * Set by an account switch just before its reload (account/accountSwitch.ts): the reloaded page has already landed,
 * so it opens on the Wallet, never on Ask b again. Owner, 13 Nov 2026: switches kept reloading onto Ask b (its WebGL
 * hero and audio live during the reload) and some ended on a black screen. sessionStorage: survives the reload only.
 */
export const SWITCH_LANDED_KEY = 'bwallet.switchLanded';
const switchLanded = () => {
  try {
    return sessionStorage.getItem(SWITCH_LANDED_KEY) === '1';
  } catch {
    return false;
  }
};
export const hasLanded = () => landedFlag || switchLanded();
export const setLanded = () => {
  landedFlag = true;
};

/** Pages kept mounted by phone/pager.tsx (once opened, or prewarmed). */
export const keptPages = new Set<ScreenId>();
let keptVersion = 0;
const keptListeners = new Set<() => void>();
/**
 * Prefetch (owner round 6): mount pages hidden before they are opened (Feed and Chat at idle after the start), so
 * their data is loaded and on screen the moment they open.
 */
export const prewarmPages = (ids: readonly ScreenId[]) => {
  const before = keptPages.size;
  ids.forEach((id) => keptPages.add(id));
  if (keptPages.size === before) return;
  keptVersion++;
  keptListeners.forEach((l) => l());
};
export const keptSubscribe = (fn: () => void) => {
  keptListeners.add(fn);
  return () => {
    keptListeners.delete(fn);
  };
};
export const keptSnapshot = () => keptVersion;
