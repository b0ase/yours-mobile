/**
 * Android Back in the phone layout (main.ts): after open sheets (backStack.ts), a strip page that is not HOME goes
 * to HOME. PhoneShell registers the handler while the layout is on; it returns true when it handled Back.
 */
let handler: (() => boolean) | null = null;

export const setPhoneBack = (fn: (() => boolean) | null) => {
  handler = fn;
};

export const phoneBack = (): boolean => (handler ? handler() : false);

/** The rule: Back on a strip page other than HOME goes HOME; on HOME (or off the strip) it does what it did before. */
export const backGoesHome = (screenId: string | null | undefined) => !!screenId && screenId !== 'home';
