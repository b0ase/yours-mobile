import { createContext } from 'react';

/**
 * Guest view (signed out or locked, web/Desktop only; GuestMusic.tsx): the callback that opens create/unlock and
 * comes back to the same page. Anything that needs the wallet (playing, buying) calls it instead.
 */
export const GuestCtx = createContext<null | (() => void)>(null);
