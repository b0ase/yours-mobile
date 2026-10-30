/**
 * What closing the approval prompt may close. The prompt can live in our own popup window, in a normal
 * browser tab (opened in-tab), or in an iframe sheet over a site tab. Only the surface we opened is ever
 * closed: a window is removed only when every tab in it is ours (extension pages), otherwise just the
 * prompt tab goes, and an iframe sheet is hidden, never its host tab. (30 Oct 2026: "Pay and swap" closed
 * the whole browser window holding the wallet tab and the site tab.)
 */
export type PromptCloseTarget =
  | { type: 'window'; windowId: number }
  | { type: 'tab'; tabId: number }
  | { type: 'sheet'; tabId: number }
  | { type: 'none' };

export type PromptCloseInput = {
  /** The id of the prompt window, if the prompt is in a window. */
  windowId?: number;
  /** That window as chrome.windows.get({ populate: true }) returned it, or undefined if it is gone. */
  window?: { type?: string; tabs?: { id?: number; url?: string }[] };
  /** The tab that sent the close request (chrome.runtime.MessageSender.tab). */
  senderTab?: { id?: number; url?: string };
  /** The frame that sent it: > 0 means prompt.html is an iframe inside someone else's page. */
  senderFrameId?: number;
  /** chrome.runtime.getURL('') */
  extOrigin: string;
  /** chrome.runtime.getURL('prompt.html') */
  promptUrl: string;
};

export function promptCloseTarget(a: PromptCloseInput): PromptCloseTarget {
  if (a.senderFrameId !== undefined && a.senderFrameId > 0) {
    return a.senderTab?.id !== undefined ? { type: 'sheet', tabId: a.senderTab.id } : { type: 'none' };
  }
  const tabs = a.window?.tabs ?? [];
  const allOurs = tabs.length > 0 && tabs.every((t) => !!t.url && t.url.startsWith(a.extOrigin));
  if (a.windowId !== undefined && a.window && a.window.type === 'popup' && allOurs) {
    return { type: 'window', windowId: a.windowId };
  }
  if (a.senderTab?.id !== undefined && a.senderTab.url?.startsWith(a.promptUrl)) {
    return { type: 'tab', tabId: a.senderTab.id };
  }
  const promptTab = tabs.find((t) => t.id !== undefined && !!t.url && t.url.startsWith(a.promptUrl));
  if (promptTab?.id !== undefined) return { type: 'tab', tabId: promptTab.id };
  return { type: 'none' };
}
