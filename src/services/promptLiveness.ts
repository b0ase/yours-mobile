/**
 * BRC-219, the Wallet Permission Prompt Liveness Contract (owner, 8 Nov 2026).
 *
 * A site's request that waits on the person stays pending until they answer: an approval sheet that is up never
 * expires on a timer (the 60 s PROMPT_EXPIRY_MS is gone). A waiting request still fails, clearly, when:
 *  - its prompt was never shown (promptWatchdog.ts, ERR_PROMPT_NOT_SHOWN; unchanged);
 *  - it waits behind another sheet the person can see for too long (promptWatchdog.ts, ERR_PROMPT_BUSY; unchanged);
 *  - the prompt surface is gone: the person closed the window, the side panel or the in-page sheet (background.ts
 *    denyAllPendingPrompts; unchanged), or the unlock screen it waits on (unlockSurfaceGone below);
 *  - the caller is gone: the page that asked was closed or left (SiteCallTabs below, ERR_PROMPT_CALLER_GONE).
 *
 * Failing a request here is the same as Deny before anything was built or signed: it rejects the permission request
 * itself and never touches a transaction (noSend / unsent release logic is elsewhere and unchanged).
 */

export const PROMPT_CALLER_GONE_CODE = 'ERR_PROMPT_CALLER_GONE';
export const PROMPT_CALLER_GONE_MESSAGE =
  'The page that asked for this was closed or left before you answered, so bWalletX closed its sheet. Nothing was paid or signed.';

/** An Error a site can tell apart: code ERR_PROMPT_CALLER_GONE, status 410. */
export function promptCallerGoneError(): Error & { code: string; status: number } {
  return Object.assign(new Error(PROMPT_CALLER_GONE_MESSAGE), { code: PROMPT_CALLER_GONE_CODE, status: 410 });
}

/**
 * Which browser tabs have a site's wallet call still waiting for its answer (extension only: the phone and web
 * wallets have no tabs). When a tab closes or loads another page, the answer can never be delivered; if no other tab
 * of the same site is still waiting, that site's open sheets are closed (the sheet cannot say which tab asked).
 */
export class SiteCallTabs {
  private tabs = new Map<number, Map<string, number>>();

  /** A site's call from `tabId` started. Returns the function to call once it has been answered (idempotent). */
  begin(tabId: number, site: string): () => void {
    let calls = this.tabs.get(tabId);
    if (!calls) this.tabs.set(tabId, (calls = new Map()));
    calls.set(site, (calls.get(site) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const now = this.tabs.get(tabId);
      if (!now || now !== calls) return; // the tab already went away
      const n = (now.get(site) ?? 1) - 1;
      if (n > 0) now.set(site, n);
      else now.delete(site);
      if (now.size === 0) this.tabs.delete(tabId);
    };
  }

  /**
   * The tab closed or left its page: forget it. Returns the sites that had a call waiting there and have none
   * waiting in any other tab: their sheets belong to a caller that is gone.
   */
  tabGone(tabId: number): string[] {
    const calls = this.tabs.get(tabId);
    if (!calls) return [];
    this.tabs.delete(tabId);
    return [...calls.keys()].filter((site) => ![...this.tabs.values()].some((m) => (m.get(site) ?? 0) > 0));
  }

  waiting(tabId: number): number {
    let n = 0;
    for (const c of this.tabs.get(tabId)?.values() ?? []) n += c;
    return n;
  }
}

export type UnlockSurfaceState = {
  /** Site calls waiting on the wallet (pendingWalletWaiters). */
  waiting: number;
  /** They wait on Create / Restore, not unlock: the setup wait handles its own window (walletSetupWait.ts). */
  setup: boolean;
  /** An unlock (or account switch) is already finishing: the waiters are about to be answered. */
  unlocking: boolean;
  /** Open wallet panels (the side panel or toolbar popup; the phone and web wallet UI itself). */
  panels: number;
  /** The wallet's own prompt window is open. */
  popupWindow: boolean;
  /** The in-page sheet is over a site. */
  inPageSheet: boolean;
};

/**
 * True when site calls wait for an unlock and nothing can show the unlock screen any more: no panel, no prompt window
 * and no in-page sheet. The waiters are then failed (a lifecycle error, not a timeout). While any of those is up the
 * unlock waits for the person however long they take (BRC-219).
 */
export const unlockSurfaceGone = (s: UnlockSurfaceState): boolean =>
  s.waiting > 0 && !s.setup && !s.unlocking && s.panels === 0 && !s.popupWindow && !s.inPageSheet;

/** Something is up the person can still answer for this site: an open sheet, or the unlock / setup screen. */
export type SiteAskingState = {
  /** The site's open sheets that the prompt UI has confirmed it is showing (or that wait behind one it is). */
  shownSheets: number;
  /** Other sheets of the site that wait for their own answer (1Sat, envelopes, private mints, Twetch, holdings). */
  otherSheets: number;
  /** Site calls waiting on the unlock or wallet setup screen. */
  walletWaiters: number;
};

/**
 * The phone/web bridge's ceiling hit for a site's call (mobile/dappBrowser.ts): true while the person can still answer
 * it, so the bridge keeps waiting instead of closing the sheet and telling the site "timed out" (BRC-219).
 */
export const siteStillAsking = (s: SiteAskingState): boolean =>
  s.shownSheets > 0 || s.otherSheets > 0 || s.walletWaiters > 0;
