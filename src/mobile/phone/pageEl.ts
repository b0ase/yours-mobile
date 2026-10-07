import { createContext, useContext } from 'react';

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
