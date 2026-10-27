/**
 * The tiny, dependency-free part of the twetch.* calls (twetchCalls.ts): the action names. Page scripts (cwi.ts) and
 * the content script import this, never the signing code.
 */
export const TWETCH_STATUS = 'twetch.status';
export const TWETCH_LOGIN = 'twetch.loginSign';
export const TWETCH_POST = 'twetch.buildPost';
export const isTwetchAction = (action: unknown): action is string =>
  action === TWETCH_STATUS || action === TWETCH_LOGIN || action === TWETCH_POST;
