import { createContext, useContext } from 'react';

/** Shared by the phone layout's pager (pager.tsx, PhoneShell.tsx) and TopNav. */

/** True inside a neighbour preview during a page drag: TopNav renders nothing there. */
export const PeekContext = createContext(false);
export const useInPeek = () => useContext(PeekContext);

let pageEl: HTMLDivElement | null = null;
export const setPageEl = (el: HTMLDivElement | null) => {
  pageEl = el;
};
/** The element holding the routed page (null while the phone layout is off). */
export const getPageEl = () => pageEl;
