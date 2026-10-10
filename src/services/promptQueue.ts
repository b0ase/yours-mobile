/**
 * One approval at a time (10 Oct 2026, bChatX first sign-in): a site asked for two signatures at once, the second
 * request's SHOW_PROMPT replaced the first prompt mid-answer, and the side panel was left on a spinning Allow.
 * The prompt UI (side panel, in-page sheet or window) now keeps the prompt it is showing until it is answered;
 * later requests wait in the background's queue and the UI picks them up in turn (prompt-tab advance →
 * GET_NEXT_PROMPT).
 */
export type ShownPrompt = { kind: string; requestID?: string };

/**
 * Should a newly queued prompt be pushed into an already-open prompt UI now?
 * No while that UI is still showing a different request that is still pending; yes when it is idle (nothing
 * shown, or what it showed has been answered) or when the incoming request is the one it is showing (a refresh).
 */
export const shouldPushPrompt = (
  shown: ShownPrompt | undefined,
  shownStillPending: boolean,
  incoming: ShownPrompt,
): boolean => {
  if (!shown || !shownStillPending) return true;
  return shown.kind === incoming.kind && shown.requestID === incoming.requestID;
};

/**
 * A wallet call is waiting for the wallet to unlock. With the side panel open the panel must show its unlock
 * screen, and any prompt overlay still up there (its request gone) must be cleared first, or nothing appears and
 * the site's waitForAuthentication never resolves. Messages for the panel port, in order.
 */
export const panelUnlockMessages = () => [{ action: 'HIDE_PROMPT_PANEL' }, { action: 'SHOW_UNLOCK_PANEL' }] as const;
